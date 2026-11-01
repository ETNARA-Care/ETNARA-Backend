/**
 * Resident and establishment documents (migration 125), end to end over HTTP
 * as app_runtime, with a local private S3 (moto started here, never a hosted
 * service) and synthetic data only.
 *
 * Proves: the agency can upload / list / open / archive; caregivers, relatives,
 * another agency and a forged context cannot; ETNARA central never sees
 * resident documents but keeps the ETNARA Verified review of establishment
 * documents; a failed INSERT after the upload leaves no orphan file; nothing
 * sensitive reaches responses' storage keys or the logs.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: DOCS_TEST_S3_PORT (default 4569), PHOTO_TEST_PYTHON (python with moto[server]).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

// Everything the server logs during the run (checked for sensitive content).
const logged: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
for (const level of ["info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
}
const out = (line: string) => process.stdout.write(line + "\n");

async function main() {
  // ------------------------------------------------------------ local S3 (moto)
  const s3Port = Number(process.env.DOCS_TEST_S3_PORT ?? 4569);
  const motoLog: string[] = [];
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: ["ignore", "pipe", "pipe"] });
  moto.stdout?.on("data", (d) => motoLog.push(String(d)));
  moto.stderr?.on("data", (d) => motoLog.push(String(d)));
  let spawnError: Error | null = null;
  moto.on("error", (e) => { spawnError = e; });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 360 && !spawnError; i++) {
    try { await fetch(endpoint); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) {
    const why = `Local S3 (moto) did not start: ${spawnError ? (spawnError as Error).message : "timeout"} ${motoLog.join("").slice(-1500)}`;
    out(why);
    if (process.env.GITHUB_ACTIONS) out(`::error title=Local S3::${why.replace(/\n/g, "%0A")}`);
    moto.kill();
    process.exit(1);
  }
  const bucket = `etnara-docs-test-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, {
    STORAGE_ENDPOINT: endpoint, STORAGE_REGION: "us-east-1", STORAGE_BUCKET: bucket,
    STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true",
  });
  const objectCount = async (prefix: string) => {
    let n = 0; let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      n += page.KeyCount ?? 0; token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return n;
  };
  const head = async (key: string) => { try { return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? -1; } catch { return null; } };

  // ------------------------------------------------------------ database + app
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const runtime = new pg.Client({ connectionString: u.toString() });
  await runtime.connect();

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  const bodies: string[] = [];

  async function call(method: string, path: string, token: string, body?: Json | Buffer, contentType?: string) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": contentType ?? (isBuf ? "application/pdf" : "application/json") } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    const text = await res.text();
    bodies.push(text);
    let json: Json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, body: json };
  }

  /** One statement as app_runtime with a context; always rolled back. */
  async function rt(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`,
        [userId, orgId, superadmin ? "true" : "false"]);
      const r = await runtime.query(text, params);
      return { rows: r.rows as Json[], rowCount: r.rowCount ?? 0, error: null as string | null, code: null as string | null };
    } catch (e) {
      return { rows: [] as Json[], rowCount: 0, error: (e as Error).message, code: (e as { code?: string }).code ?? null };
    } finally {
      await runtime.query("ROLLBACK").catch(() => undefined);
    }
  }
  const rlsCount = async (userId: string, orgId: string, table: string, where: string, params: unknown[], superadmin = false) => {
    const r = await rt(userId, orgId, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params, superadmin);
    return r.error ? `ERR ${r.code}` : Number(r.rows[0].n);
  };

  // ------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`DOC A ${tag}`);
  const orgB = await org(`DOC B ${tag}`);
  const location = async (o: string, name: string) => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, `${name} ${tag}`])).rows[0].id;
  const estA = await location(orgA, "Hogar A1"), estA2 = await location(orgA, "Hogar A2"), estB = await location(orgB, "Hogar B1");
  type P = { email: string; userId: string; token: string; membershipId: string };
  async function person(key: string, orgId: string, roles: string[], internalRole?: string): Promise<P> {
    const email = `doc-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membershipId = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membershipId, orgId, roles]);
    if (internalRole) {
      const workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Sintetica ${key}`])).rows[0].id;
      await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active',$3)`, [workerId, orgId, internalRole]);
    }
    return { email, userId, token: "", membershipId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]),
    sup: await person("a-sup", orgA, ["SUPERVISOR"]),
    estAdmin: await person("a-estadmin", orgA, ["WORKER"], "admin"),
    cg: await person("a-cg", orgA, ["WORKER"], "caregiver"),
    family: await person("a-family", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]) };
  const platform = await person("platform", orgB, []);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platform.userId]);
  await q(`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4)`, [orgA, estA, A.estAdmin.membershipId, A.admin.userId]);
  const residentLast = `Zayas${tag}`;
  const recipient = async (o: string, loc: string) => (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name,status,location_id) VALUES ($1,'Sintetico',$2,'active',$3) RETURNING id`, [o, residentLast, loc])).rows[0].id;
  const rA = await recipient(orgA, estA), rA2 = await recipient(orgA, estA2), rB = await recipient(orgB, estB);
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [A.family.userId, orgA, rA]);
  const owmCg = (await q<{ id: string }>(`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id WHERE w.user_id=$1`, [A.cg.userId])).rows[0].id;
  const shift = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','in_progress') RETURNING id`, [orgA, rA])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,response_status,responded_at) VALUES ($1,$2,$3,'accepted',now())`, [orgA, shift, owmCg]);

  for (const [p, o] of [...Object.values(A).map((p) => [p, orgA] as const), [B.admin, orgB] as const, [platform, orgB] as const]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }

  const secretTitle = `Orden medica ${tag}`;
  const secretFile = `expediente-${residentLast}.pdf`;
  const pdf = Buffer.from(`%PDF-1.4 synthetic ${tag}\n%%EOF`);
  const RD = (o: string, e: string, r: string) => `/organizations/${o}/establishments/${e}/residents/${r}/documents`;
  const ED = (o: string, e: string) => `/organizations/${o}/establishments/${e}/documents`;
  const qs = (title: string, type: string, file: string, extra = "") => `?title=${encodeURIComponent(title)}&documentType=${encodeURIComponent(type)}&fileName=${encodeURIComponent(file)}${extra}`;
  const rdPrefix = `resident-documents/${orgA}/`;
  const edPrefix = `establishment-documents/${orgA}/`;

  try {
    // ------------------------------------------------------------ schema posture
    const priv = (await q<Json>(`SELECT
        has_table_privilege('app_runtime','resident_documents','SELECT') rs, has_table_privilege('app_runtime','resident_documents','INSERT') ri,
        has_table_privilege('app_runtime','resident_documents','DELETE') rd, has_column_privilege('app_runtime','resident_documents','archived_at','UPDATE') ru,
        has_column_privilege('app_runtime','resident_documents','title','UPDATE') rut,
        has_table_privilege('app_runtime','establishment_documents','SELECT') es, has_table_privilege('app_runtime','establishment_documents','DELETE') ed,
        has_column_privilege('app_runtime','establishment_documents','storage_key','UPDATE') euk,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='resident_documents'::regclass) rf,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='establishment_documents'::regclass) ef,
        (SELECT count(*)::int FROM pg_policies WHERE tablename IN ('resident_documents','establishment_documents') AND (qual ILIKE '%current_organization_id%' OR with_check ILIKE '%current_organization_id%')) badguc`)).rows[0];
    check("P1 app_runtime: SELECT/INSERT + archive-only UPDATE, no DELETE; FORCE RLS; no policy reads app.current_organization_id",
      priv.rs && priv.ri && !priv.rd && priv.ru && !priv.rut && priv.es && !priv.ed && !priv.euk && priv.rf && priv.ef && priv.badguc === 0, JSON.stringify(priv));

    // ------------------------------------------------------------ resident documents: agency
    const before = await objectCount(rdPrefix);
    const up = await call("POST", RD(orgA, estA, rA) + qs(secretTitle, "medical_order", secretFile, "&issuedOn=2026-01-01&expiresOn=2027-01-01"), A.admin.token, pdf);
    const docId = up.body.document?.id as string | undefined;
    const row = docId ? (await q<Json>(`SELECT storage_key,size_bytes::int AS size,organization_id,care_recipient_id FROM resident_documents WHERE id=$1`, [docId])).rows[0] : undefined;
    const size = row ? await head(row.storage_key) : null;
    check("R1 agency admin uploads a resident document: 201, row written, object stored with the same size",
      up.status === 201 && !!row && size === pdf.byteLength && row.size === pdf.byteLength && row.organization_id === orgA && (await objectCount(rdPrefix)) === before + 1,
      `status=${up.status} row=${!!row} size=${size}`);
    const list = await call("GET", RD(orgA, estA, rA), A.admin.token);
    const supList = await call("GET", RD(orgA, estA, rA), A.sup.token);
    check("R2 agency admin and supervisor list it (no storage key in the response)",
      list.status === 200 && list.body.documents?.some((d: Json) => d.id === docId) && supList.status === 200 && supList.body.documents?.length === list.body.documents?.length
        && !JSON.stringify(list.body).includes("storage_key") && !JSON.stringify(list.body).includes("resident-documents/"),
      `${list.status} ${supList.status} n=${list.body.documents?.length}`);
    const open = await call("GET", `${RD(orgA, estA, rA)}/${docId}/download`, A.admin.token);
    const fetched = open.body.url ? await fetch(open.body.url) : null;
    const bytes = fetched ? Buffer.from(await fetched.arrayBuffer()) : Buffer.alloc(0);
    check("R3 open issues a short-lived signed URL that returns the same bytes", open.status === 200 && /X-Amz-Expires=300/.test(open.body.url ?? "") && fetched?.status === 200 && bytes.equals(pdf),
      `status=${open.status} fetch=${fetched?.status}`);

    // ------------------------------------------------------------ resident documents: denied in the same agency
    const deniedSet = [] as string[];
    for (const [label, who] of [["caregiver", A.cg], ["family", A.family]] as const) {
      const l = await call("GET", RD(orgA, estA, rA), who.token);
      const o = await call("GET", `${RD(orgA, estA, rA)}/${docId}/download`, who.token);
      const objs = await objectCount(rdPrefix);
      const p = await call("POST", RD(orgA, estA, rA) + qs("x", "other", "x.pdf"), who.token, pdf);
      const a = await call("DELETE", `${RD(orgA, estA, rA)}/${docId}`, who.token);
      const n = await rlsCount(who.userId, orgA, "resident_documents", "care_recipient_id=$1", [rA]);
      const ins = await rt(who.userId, orgA, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgA, estA, rA, `probe/${randomUUID()}`]);
      const ok = [l, o, p, a].every((r) => r.status === 403 || r.status === 404) && n === 0 && ins.code === "42501" && (await objectCount(rdPrefix)) === objs;
      if (!ok) deniedSet.push(`${label}: ${l.status}/${o.status}/${p.status}/${a.status} rls=${n} ins=${ins.code}`);
    }
    check("R4 caregiver assigned to the resident and the resident's relative: list/open/upload/archive 403, RLS 0 rows, INSERT rejected, nothing stored",
      deniedSet.length === 0, deniedSet.join("; ") || "caregiver, family denied");
    const estAdminRA = await call("GET", RD(orgA, estA, rA), A.estAdmin.token);
    const estAdminOther = await call("GET", RD(orgA, estA2, rA2), A.estAdmin.token);
    check("R5 establishment admin of A1 never reaches residents of another establishment (A2)", estAdminOther.status === 403,
      `A2=${estAdminOther.status} (A1=${estAdminRA.status}: residents need care_recipients visibility, unchanged by 125)`);

    // ------------------------------------------------------------ resident documents: other agency
    const bList = await call("GET", RD(orgB, estA, rA), B.admin.token);
    const bOpen = await call("GET", `${RD(orgB, estA, rA)}/${docId}/download`, B.admin.token);
    const bArchive = await call("DELETE", `${RD(orgB, estA, rA)}/${docId}`, B.admin.token);
    const bForeign = await call("GET", RD(orgA, estA, rA), B.admin.token);
    const bForeignOpen = await call("GET", `${RD(orgA, estA, rA)}/${docId}/download`, B.admin.token);
    const leakB = [bList, bOpen, bArchive, bForeign, bForeignOpen].some((r) => r.body.documents || r.body.url);
    check("R6 agency B admin cannot list/open/archive A's resident document (own-org path 403; A's path refused without data)",
      [bList, bOpen, bArchive].every((r) => r.status === 403) && bForeign.status >= 400 && bForeignOpen.status >= 400 && !leakB,
      `own=${bList.status}/${bOpen.status}/${bArchive.status} foreign=${bForeign.status}/${bForeignOpen.status}`);
    const bRls = await rlsCount(B.admin.userId, orgB, "resident_documents", "id=$1", [docId]);
    const bForged = await rlsCount(B.admin.userId, orgA, "resident_documents", "id=$1", [docId]);
    const bUpd = await rt(B.admin.userId, orgB, `UPDATE resident_documents SET archived_at=now() WHERE id=$1`, [docId]);
    const bInsA = await rt(B.admin.userId, orgB, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgA, estA, rA, `probe/${randomUUID()}`]);
    const bInsOwn = await rt(B.admin.userId, orgB, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgB, estA, rA, `probe/${randomUUID()}`]);
    const bInsForged = await rt(B.admin.userId, orgA, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgA, estA, rA, `probe/${randomUUID()}`]);
    check("R7 RLS for agency B: 0 rows (own and forged context), UPDATE touches 0 rows, INSERT pointing to A's org/resident rejected",
      bRls === 0 && bForged === 0 && bUpd.rowCount === 0 && !bUpd.error && bInsA.code === "42501" && bInsOwn.code === "42501" && bInsForged.code === "42501",
      `rls=${bRls} forged=${bForged} upd=${bUpd.rowCount} ins=${bInsA.code}/${bInsOwn.code}/${bInsForged.code}`);
    const wrongEst = await rt(A.admin.userId, orgA, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgA, estA2, rA, `probe/${randomUUID()}`]);
    const goodIns = await rt(A.admin.userId, orgA, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4) RETURNING id`, [orgA, estA, rA, `probe/${randomUUID()}`]);
    check("R8 qualified EXISTS: agency A cannot file a resident document under an establishment the resident is not in; the right establishment works",
      wrongEst.code === "42501" && goodIns.rowCount === 1, `wrong=${wrongEst.code} good=${goodIns.rowCount} ${goodIns.error ?? ""}`);

    // ------------------------------------------------------------ resident documents: ETNARA central
    const agencySees = await rlsCount(A.admin.userId, orgA, "resident_documents", "organization_id=$1", [orgA]);
    const platNoOrg = await rlsCount(platform.userId, "", "resident_documents", "true", [], true);
    const platOrgA = await rlsCount(platform.userId, orgA, "resident_documents", "organization_id=$1", [orgA], true);
    const platIns = await rt(platform.userId, orgA, `INSERT INTO resident_documents (organization_id,establishment_id,care_recipient_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,$3,'x','x','x.pdf','application/pdf',1,$4)`, [orgA, estA, rA, `probe/${randomUUID()}`], true);
    check("R9 ETNARA central (verified platform admin): 0 resident documents with or without an org context, INSERT rejected; positive control: agency sees them",
      typeof agencySees === "number" && agencySees >= 1 && platNoOrg === 0 && platOrgA === 0 && platIns.code === "42501", `agency=${agencySees} central=${platNoOrg}/${platOrgA} ins=${platIns.code}`);

    // ------------------------------------------------------------ resident documents: forced INSERT failure after upload
    const beforeFail = await objectCount(rdPrefix);
    const failUp = await call("POST", RD(orgA, estA, rA) + qs(`${secretTitle} bad`, "medical_order", secretFile, "&issuedOn=2026-02-01&expiresOn=2026-01-01"), A.admin.token, pdf);
    const failUp2 = await call("POST", RD(orgA, estA, rA) + qs(`${secretTitle} bad2`, "medical_order", secretFile, "&issuedOn=not-a-date"), A.admin.token, pdf);
    const afterFail = await objectCount(rdPrefix);
    const failRows = Number((await q(`SELECT count(*)::int n FROM resident_documents WHERE title LIKE $1`, [`${secretTitle} bad%`])).rows[0].n);
    check("R10 INSERT fails after the upload (CHECK violation, invalid date): 500, no row, and the just-uploaded file is deleted (no new orphan)",
      failUp.status === 500 && failUp2.status === 500 && failRows === 0 && afterFail === beforeFail, `status=${failUp.status}/${failUp2.status} objects ${beforeFail}->${afterFail} rows=${failRows}`);

    // ------------------------------------------------------------ resident documents: archive
    const archive = await call("DELETE", `${RD(orgA, estA, rA)}/${docId}`, A.admin.token);
    const after = await call("GET", RD(orgA, estA, rA), A.admin.token);
    const archivedRow = (await q<Json>(`SELECT archived_at FROM resident_documents WHERE id=$1`, [docId])).rows[0];
    const reopen = await call("GET", `${RD(orgA, estA, rA)}/${docId}/download`, A.admin.token);
    check("R11 archive: 204, gone from the list, cannot be reopened, row kept (archived_at) and file kept (no destructive delete)",
      archive.status === 204 && !after.body.documents?.some((d: Json) => d.id === docId) && !!archivedRow?.archived_at && reopen.status === 404 && (await head(row?.storage_key)) === pdf.byteLength,
      `${archive.status} reopen=${reopen.status}`);
    const updOther = await rt(A.admin.userId, orgA, `UPDATE resident_documents SET title='changed' WHERE id=$1`, [docId]);
    check("R12 runtime may only change archive columns (UPDATE title rejected by grant)", updOther.code === "42501", String(updOther.code));

    // ------------------------------------------------------------ establishment documents: agency
    const eBefore = await objectCount(edPrefix);
    const eUp = await call("POST", ED(orgA, estA) + qs(`Permiso ${tag}`, "operating_license", "permiso-salud.pdf", "&expiresOn=2027-06-30"), A.admin.token, pdf);
    const eDoc = eUp.body.document?.id as string | undefined;
    const eRow = eDoc ? (await q<Json>(`SELECT storage_key,review_status FROM establishment_documents WHERE id=$1`, [eDoc])).rows[0] : undefined;
    check("E1 agency admin uploads an establishment document: 201, pending review, object stored",
      eUp.status === 201 && eRow?.review_status === "pending" && (await head(eRow?.storage_key)) === pdf.byteLength && (await objectCount(edPrefix)) === eBefore + 1, `status=${eUp.status}`);
    const eEstUp = await call("POST", ED(orgA, estA) + qs(`Incendio ${tag}`, "fire_inspection", "incendio.pdf"), A.estAdmin.token, pdf);
    const eList = await call("GET", ED(orgA, estA), A.estAdmin.token);
    const eHist = await call("GET", `/organizations/${orgA}/establishments/${estA}/documents-history`, A.admin.token);
    const eOpen = await call("GET", `${ED(orgA, estA)}/${eDoc}/download`, A.estAdmin.token);
    check("E2 establishment admin of A1 uploads, lists, sees history and opens (signed URL)",
      eEstUp.status === 201 && eList.status === 200 && eList.body.documents?.length === 2 && eHist.status === 200 && eOpen.status === 200 && !!eOpen.body.url,
      `${eEstUp.status} ${eList.status} n=${eList.body.documents?.length} ${eHist.status} ${eOpen.status}`);
    const eReplace = await call("POST", ED(orgA, estA) + qs(`Permiso nuevo ${tag}`, "operating_license", "permiso-2.pdf"), A.admin.token, pdf);
    const eOld = (await q<Json>(`SELECT archived_at FROM establishment_documents WHERE id=$1`, [eDoc])).rows[0];
    check("E3 a new document of the same type archives the previous one", eReplace.status === 201 && !!eOld.archived_at, `${eReplace.status}`);
    const eDoc2 = eReplace.body.document?.id as string;

    const eDenied: string[] = [];
    for (const [label, who, path] of [["caregiver", A.cg, ED(orgA, estA)], ["family", A.family, ED(orgA, estA)], ["est admin A1 on A2", A.estAdmin, ED(orgA, estA2)], ["agency B", B.admin, ED(orgB, estA)]] as const) {
      const l = await call("GET", path, who.token);
      const o = await call("GET", `${path}/${eDoc2}/download`, who.token);
      const objs = await objectCount(edPrefix);
      const p = await call("POST", path + qs("x", "other", "x.pdf"), who.token, pdf);
      const a = await call("DELETE", `${path}/${eDoc2}`, who.token);
      if (![l, o, p, a].every((r) => r.status === 403) || (await objectCount(edPrefix)) !== objs) eDenied.push(`${label}: ${l.status}/${o.status}/${p.status}/${a.status}`);
    }
    const eRlsCg = await rlsCount(A.cg.userId, orgA, "establishment_documents", "organization_id=$1", [orgA]);
    const eRlsB = await rlsCount(B.admin.userId, orgB, "establishment_documents", "organization_id=$1", [orgA]);
    const eRlsForged = await rlsCount(B.admin.userId, orgA, "establishment_documents", "organization_id=$1", [orgA]);
    const eInsB = await rt(B.admin.userId, orgB, `INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,'x','x','x.pdf','application/pdf',1,$3)`, [orgA, estA, `probe/${randomUUID()}`]);
    const eInsBest = await rt(B.admin.userId, orgB, `INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,'x','x','x.pdf','application/pdf',1,$3)`, [orgB, estA, `probe/${randomUUID()}`]);
    const eInsApproved = await rt(A.admin.userId, orgA, `INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,review_status,reviewed_by_user_id,reviewed_at) VALUES ($1,$2,'x','x','x.pdf','application/pdf',1,$3,'approved',$4,now())`, [orgA, estA, `probe/${randomUUID()}`, A.admin.userId]);
    check("E4 caregiver, relative, admin of another establishment and agency B: 403 on every route, nothing stored; RLS 0 rows; B cannot insert into A's org/establishment; agency cannot insert pre-approved",
      eDenied.length === 0 && eRlsCg === 0 && eRlsB === 0 && eRlsForged === 0 && eInsB.code === "42501" && eInsBest.code === "42501" && eInsApproved.code === "42501",
      `${eDenied.join("; ") || "all 403"} rls=${eRlsCg}/${eRlsB}/${eRlsForged} ins=${eInsB.code}/${eInsBest.code}/${eInsApproved.code}`);
    const selfApprove = await rt(A.admin.userId, orgA, `UPDATE establishment_documents SET review_status='approved', reviewed_by_user_id=$2, reviewed_at=now() WHERE id=$1`, [eDoc2, A.admin.userId]);
    check("E5 the agency cannot approve its own document (no self-approval; the 125 trigger is kept)", selfApprove.code === "42501", String(selfApprove.code));

    // ------------------------------------------------------------ establishment documents: ETNARA Central closed (140)
    // Central no longer has standing access: the queue answers 200 with an EMPTY list (the Central
    // portal keeps working), opening or reviewing answers 403, and RLS gives a verified platform
    // admin 0 rows with or without an organization context.
    const statusBefore = (await q<Json>(`SELECT review_status, reviewed_at FROM establishment_documents WHERE id=$1`, [eDoc2])).rows[0];
    const queue = await call("GET", "/platform/establishment-documents/verification-queue", platform.token);
    const pOpen = await call("GET", `/platform/establishment-documents/${eDoc2}/download`, platform.token);
    const approve = await call("PATCH", `/platform/establishment-documents/${eDoc2}/review`, platform.token, { status: "approved" });
    const reject = await call("PATCH", `/platform/establishment-documents/${eDoc2}/review`, platform.token, { status: "rejected", reason: "prueba" });
    const nonPlatform = await call("GET", "/platform/establishment-documents/verification-queue", A.admin.token);
    const nonPlatformOpen = await call("GET", `/platform/establishment-documents/${eDoc2}/download`, A.admin.token);
    const statusAfter = (await q<Json>(`SELECT review_status, reviewed_at FROM establishment_documents WHERE id=$1`, [eDoc2])).rows[0];
    check("E6 140: ETNARA Central has no standing access: queue 200 with 0 documents, open 403 (no URL), approve/reject 403, document unchanged; non-platform users 403",
      queue.status === 200 && Array.isArray(queue.body.documents) && queue.body.documents.length === 0 && queue.body.accessModel === "AGENCY_AUTHORIZATION_REQUIRED"
        && pOpen.status === 403 && pOpen.body.error === "PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED" && !pOpen.body.url
        && approve.status === 403 && reject.status === 403
        && statusAfter.review_status === statusBefore.review_status && String(statusAfter.reviewed_at) === String(statusBefore.reviewed_at)
        && nonPlatform.status === 403 && nonPlatformOpen.status === 403,
      `queue=${queue.status} n=${queue.body.documents?.length} open=${pOpen.status} review=${approve.status}/${reject.status} status=${statusBefore.review_status}->${statusAfter.review_status} nonPlatform=${nonPlatform.status}/${nonPlatformOpen.status}`);
    const pSee = await rlsCount(platform.userId, "", "establishment_documents", "true", [], true);
    const pSeeForged = await rlsCount(platform.userId, orgA, "establishment_documents", "organization_id=$1", [orgA], true);
    const pReview = await rt(platform.userId, "", `UPDATE establishment_documents SET review_status='approved', reviewed_by_user_id=$2, reviewed_at=now() WHERE id=$1`, [eDoc2, platform.userId], true);
    const pArchive = await rt(platform.userId, "", `UPDATE establishment_documents SET archived_at=now() WHERE id=$1`, [eDoc2], true);
    const pTitle = await rt(platform.userId, orgA, `UPDATE establishment_documents SET title='x' WHERE id=$1`, [eDoc2], true);
    const pIns = await rt(platform.userId, "", `INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key) VALUES ($1,$2,'x','x','x.pdf','application/pdf',1,$3)`, [orgA, estA, `probe/${randomUUID()}`], true);
    const agencyStill = await rlsCount(A.admin.userId, orgA, "establishment_documents", "id=$1", [eDoc2]);
    const blocked = (r: Json) => r.code === "42501" || (r.rowCount === 0 && !r.error);
    check("E7 140 at the database: Central sees 0 establishment documents (no org and forged org A), cannot review, archive, edit or insert; positive control: agency A still sees it",
      pSee === 0 && pSeeForged === 0 && blocked(pReview) && blocked(pArchive) && blocked(pTitle) && pIns.code === "42501" && agencyStill === 1,
      `see=${pSee}/${pSeeForged} review=${pReview.code ?? pReview.rowCount} archive=${pArchive.code ?? pArchive.rowCount} title=${pTitle.code ?? pTitle.rowCount} ins=${pIns.code} agency=${agencyStill}`);

    // ------------------------------------------------------------ establishment documents: failure + archive
    const eBeforeFail = await objectCount(edPrefix);
    const eFail = await call("POST", ED(orgA, estA) + qs(`Fallo ${tag}`, "other_permit", secretFile, "&issuedOn=2026-03-01&expiresOn=2026-01-01"), A.admin.token, pdf);
    const eAfterFail = await objectCount(edPrefix);
    check("E8 establishment INSERT fails after upload: 500, the just-uploaded file is deleted (no new orphan)", eFail.status === 500 && eAfterFail === eBeforeFail, `status=${eFail.status} ${eBeforeFail}->${eAfterFail}`);
    const eArch = await call("DELETE", `${ED(orgA, estA)}/${eDoc2}`, A.admin.token);
    const eArchRow = (await q<Json>(`SELECT archived_at, storage_key FROM establishment_documents WHERE id=$1`, [eDoc2])).rows[0];
    check("E9 agency archives an establishment document: 204, row archived, file kept", eArch.status === 204 && !!eArchRow.archived_at && (await head(eArchRow.storage_key)) === pdf.byteLength, `${eArch.status}`);

    // ------------------------------------------------------------ file validation (PR 1 / 140)
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const vEst0 = await objectCount(edPrefix), vRes0 = await objectCount(rdPrefix);
    const vEmpty = await call("POST", ED(orgA, estA) + qs(`V1-Vacío ${tag}`, "other_permit", "vacio.pdf"), A.admin.token, Buffer.alloc(0));
    const vEmptyR = await call("POST", RD(orgA, estA, rA) + qs(`V1-Vacío ${tag}`, "other", "vacio.pdf"), A.admin.token, Buffer.alloc(0));
    const vHtmlPdf = await call("POST", ED(orgA, estA) + qs(`V1-Html ${tag}`, "other_permit", "permiso.pdf"), A.admin.token, html);
    const vSvg = await call("POST", RD(orgA, estA, rA) + qs(`V1-Svg ${tag}`, "other", "logo.svg"), A.admin.token, svg, "image/svg+xml");
    const vHtml = await call("POST", RD(orgA, estA, rA) + qs(`V1-Html ${tag}`, "other", "pagina.html"), A.admin.token, html, "text/html");
    const vExe = await call("POST", RD(orgA, estA, rA) + qs(`V1-Exe ${tag}`, "other", "instalar.exe"), A.admin.token, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]), "application/octet-stream");
    const vMime = await call("POST", RD(orgA, estA, rA) + qs(`V1-Mime ${tag}`, "other", "orden.pdf"), A.admin.token, pdf, "text/html");
    const vDocxEst = await call("POST", ED(orgA, estA) + qs(`V1-Docx ${tag}`, "other_permit", "permiso.docx"), A.admin.token, docx, "application/octet-stream");
    const vPath = await call("POST", RD(orgA, estA, rA) + qs(`V1-Ruta ${tag}`, "other", "../../x.pdf"), A.admin.token, pdf);
    const vBig = await call("POST", RD(orgA, estA, rA) + qs(`V1-Grande ${tag}`, "other", "grande.pdf"), A.admin.token, Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024)]));
    const vRows = Number((await q(`SELECT (SELECT count(*) FROM establishment_documents WHERE title LIKE $1) + (SELECT count(*) FROM resident_documents WHERE title LIKE $1) AS n`, [`V1-%`])).rows[0].n);
    const vEst1 = await objectCount(edPrefix), vRes1 = await objectCount(rdPrefix);
    const want = (r: Json, status: number, code?: string) => r.status === status && (!code || r.body.error === code);
    check("V1 rejected before storing: empty (400 EMPTY_FILE), HTML disguised as PDF, SVG, HTML, EXE, PDF declared as text/html, Word for an institutional document, path in the name, >10 MB (413); 0 rows, 0 new files",
      want(vEmpty, 400, "EMPTY_FILE") && want(vEmptyR, 400, "EMPTY_FILE") && want(vHtmlPdf, 400, "FILE_CONTENT_MISMATCH") && want(vSvg, 400, "FILE_TYPE_NOT_ALLOWED")
        && want(vHtml, 400, "FILE_TYPE_NOT_ALLOWED") && want(vExe, 400, "FILE_TYPE_NOT_ALLOWED") && want(vMime, 400, "FILE_CONTENT_MISMATCH")
        && want(vDocxEst, 400, "FILE_TYPE_NOT_ALLOWED") && want(vPath, 400, "INVALID_FILE_NAME") && vBig.status === 413
        && vRows === 0 && vEst1 === vEst0 && vRes1 === vRes0,
      `empty=${vEmpty.status}/${vEmpty.body.error},${vEmptyR.status} htmlpdf=${vHtmlPdf.body.error} svg=${vSvg.body.error} html=${vHtml.body.error} exe=${vExe.body.error} mime=${vMime.body.error} docxEst=${vDocxEst.body.error} path=${vPath.body.error} big=${vBig.status} rows=${vRows} files=${vEst0}->${vEst1}/${vRes0}->${vRes1}`);
    const vDocx = await call("POST", RD(orgA, estA, rA) + qs(`Plan ${tag} ok`, "other", "plan.docx"), A.admin.token, docx, "application/octet-stream");
    const vPdfParams = await call("POST", ED(orgA, estA) + qs(`Seguro ${tag} ok`, "insurance", "seguro.PDF"), A.admin.token, pdf, "application/pdf; charset=binary");
    const vDocxRow = vDocx.body.document?.id ? (await q<Json>(`SELECT content_type FROM resident_documents WHERE id=$1`, [vDocx.body.document.id])).rows[0] : undefined;
    const vPdfRow = vPdfParams.body.document?.id ? (await q<Json>(`SELECT content_type FROM establishment_documents WHERE id=$1`, [vPdfParams.body.document.id])).rows[0] : undefined;
    check("V2 accepted formats keep working and the stored type is the server's canonical one (Word with octet-stream for a resident; PDF with parameters for an establishment)",
      vDocx.status === 201 && vDocxRow?.content_type === DOCX && vPdfParams.status === 201 && vPdfRow?.content_type === "application/pdf",
      `docx=${vDocx.status}/${vDocxRow?.content_type} pdf=${vPdfParams.status}/${vPdfRow?.content_type}`);
    const vCg = await call("POST", RD(orgA, estA, rA) + qs("x", "other", "x.svg"), A.cg.token, svg, "image/svg+xml");
    const vB = await call("POST", ED(orgA, estA) + qs("x", "other_permit", "x.pdf"), B.admin.token, Buffer.alloc(0));
    check("V3 permission is checked before validation: caregiver and agency B get 403/404 even with an invalid file (validation reveals nothing)",
      (vCg.status === 403 || vCg.status === 404) && vB.status >= 403 && vB.status !== 400, `cg=${vCg.status} B=${vB.status}`);

    // ------------------------------------------------------------ leaks
    // Signed download URLs embed the key by design; every other body must not.
    const keyLeak = bodies.filter((b) => !b.startsWith('{"url":')).some((b) => b.includes("storage_key") || b.includes("resident-documents/") || b.includes("establishment-documents/") || b.includes(bucket));
    const logLeak = logged.some((l) => l.includes(secretTitle) || l.includes(secretFile) || l.includes(residentLast) || l.includes("resident-documents/") || l.includes("establishment-documents/") || l.includes(rA) || l.includes(tag));
    check("L1 no response other than the signed URL carries a storage key or bucket; no log line carries a title, file name, resident name, key or resident id",
      !keyLeak && !logLeak, `responses=${keyLeak} logs=${logLeak} (${logged.length} log lines)`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
    Object.assign(console, originals);
  }

  out("\nResident and establishment documents (migration 125)\n");
  out("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) out(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  const gh = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 900);
  if (process.env.GITHUB_ACTIONS) for (const r of results.filter((x) => !x.pass)) out(`::error title=${gh(r.check.slice(0, 60))}::${gh(r.detail)}`);
  out(`\nDocument access: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  Object.assign(console, originals);
  if (process.env.GITHUB_ACTIONS) out(`::error title=Document access crashed::${String((error as Error)?.stack ?? error).replace(/\n/g, "%0A").slice(0, 1500)}`);
  console.error("Document access verification failed:", error);
  process.exit(1);
});

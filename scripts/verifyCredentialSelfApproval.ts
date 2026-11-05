/**
 * B1/B2 (migración 149) — nadie decide sobre su propia credencial. Verificación de punta a punta
 * en una base DESECHABLE: la aplicación real por HTTP como app_runtime, S3 local (moto) y el
 * acceso directo a la base como app_runtime (la "puerta trasera" que usaría código futuro).
 * Personas, agencias y documentos ficticios.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 *   optional: CRED_TEST_S3_PORT (default 4571), PHOTO_TEST_PYTHON (python with moto[server]).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });
const out = (s: string) => process.stdout.write(s + "\n");

async function main() {
  // ------------------------------------------------------------ local S3 (moto)
  const s3Port = Number(process.env.CRED_TEST_S3_PORT ?? 4571);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(endpoint); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const bucket = `cred-${randomUUID().slice(0, 8)}`;
  await new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } }).send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, { STORAGE_ENDPOINT: endpoint, STORAGE_REGION: "us-east-1", STORAGE_BUCKET: bucket, STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true" });

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
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => undefined; console.error = () => undefined; console.warn = () => undefined;

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);

  async function call(method: string, path: string, token: string, body?: Json | Buffer, contentType?: string) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": contentType ?? (isBuf ? "application/pdf" : "application/json") } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, body: json };
  }
  /** One statement as app_runtime with a context; always rolled back. */
  async function rt(userId: string, orgId: string, text: string, params: unknown[] = [], superadmin = false) {
    await runtime.query("BEGIN");
    try {
      await runtime.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true), set_config('app.is_superadmin',$3,true)`, [userId, orgId, superadmin ? "true" : "false"]);
      const r = await runtime.query(text, params);
      return { rows: r.rows as Json[], rowCount: r.rowCount ?? 0, code: null as string | null, message: "" };
    } catch (e) {
      return { rows: [] as Json[], rowCount: 0, code: (e as { code?: string }).code ?? "ERR", message: (e as Error).message };
    } finally {
      await runtime.query("ROLLBACK").catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ fixtures
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`CRED A ${tag}`), orgB = await org(`CRED B ${tag}`);
  type P = { key: string; email: string; userId: string; token: string; membershipId: string; workerId?: string; owmId?: string };
  async function person(key: string, orgId: string, roles: string[], worker: boolean): Promise<P> {
    const email = `cred-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membershipId = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membershipId, orgId, roles]);
    const p: P = { key, email, userId, token: "", membershipId };
    if (worker) {
      p.workerId = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [userId, `Ficticia ${key}`])).rows[0].id;
      p.owmId = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [p.workerId, orgId])).rows[0].id;
    }
    return p;
  }
  const A = {
    adm: await person("adm", orgA, ["ORGANIZATION_ADMIN"], false),
    sup: await person("sup", orgA, ["SUPERVISOR"], false),
    admCg: await person("adm-cg", orgA, ["ORGANIZATION_ADMIN", "WORKER"], true),
    supCg: await person("sup-cg", orgA, ["SUPERVISOR", "WORKER"], true),
    cg: await person("cg", orgA, ["WORKER"], true),
    cg2: await person("cg2", orgA, ["WORKER"], true),
  };
  const B = { adm: await person("b-adm", orgB, ["ORGANIZATION_ADMIN"], false) };
  // Small agency C: its ONLY administrator is also a caregiver; one more caregiver.
  const orgC = await org(`CRED C ${tag}`);
  const C = { admCg: await person("c-adm-cg", orgC, ["ORGANIZATION_ADMIN", "WORKER"], true), cg: await person("c-cg", orgC, ["WORKER"], true) };
  // Other effective roles of agency A: a relative and an establishment administrator (a caregiver).
  const family = await person("a-family", orgA, ["FAMILY"], false);
  const estAdmin = await person("a-estadmin", orgA, ["WORKER"], true);
  const locA = (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,'Hogar ficticio') RETURNING id`, [orgA])).rows[0].id;
  await q(`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id,created_by_user_id) VALUES ($1,$2,$3,$4)`, [orgA, locA, estAdmin.membershipId, A.adm.userId]);
  const platform = await person("platform", orgB, [], false);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [platform.userId]);
  for (const [p, o] of [...Object.values(A).map((x) => [x, orgA] as const), [family, orgA] as const, [estAdmin, orgA] as const, [B.adm, orgB] as const, [C.admCg, orgC] as const, [C.cg, orgC] as const, [platform, orgB] as const]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    p.token = r.body.token;
    await call("POST", "/me/active-organization", p.token, { organizationId: o });
  }
  // Agency A policy for CNA (the agency's own decision): license with agency approval + CPR without.
  const typeId = async (code: string) => (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code=$1`, [code])).rows[0].id;
  const rs = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,worker_role,name) VALUES ($1,'CNA','Requisitos CNA') RETURNING id`, [orgA])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,true),($1,$3,true,false)`, [rs, await typeId("PROFESSIONAL_LICENSE"), await typeId("CPR")]);
  /** A credential with evidence, created as the migrations superuser (fixtures only). */
  async function seedCredential(p: P, code: string, expires: string) {
    const t = await typeId(code);
    const file = (await q<{ id: string }>(`INSERT INTO stored_files (scope_type,owner_worker_id,storage_key,content_type,original_filename,size_bytes,uploaded_by_user_id,visibility,status)
      VALUES ('PLATFORM_PROFESSIONAL',$1,$2,'application/pdf','licencia.pdf',10,$3,'private','active') RETURNING id`, [p.workerId, `credentials/${p.workerId}/seed-${randomUUID()}`, p.userId])).rows[0].id;
    const doc = (await q<{ id: string }>(`INSERT INTO documents (worker_id,credential_type_id,file_id,status) VALUES ($1,$2,$3,'presented') RETURNING id`, [p.workerId, t, file])).rows[0].id;
    await q(`INSERT INTO document_versions (document_id,file_id,version) VALUES ($1,$2,1)`, [doc, file]);
    return (await q<{ id: string }>(`INSERT INTO credentials (worker_id,credential_type_id,document_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,$3,'government','active',$4) RETURNING id`, [p.workerId, t, doc, expires])).rows[0].id;
  }
  const lic = {
    cg: await seedCredential(A.cg, "PROFESSIONAL_LICENSE", "2027-12-31"),
    cg2: await seedCredential(A.cg2, "PROFESSIONAL_LICENSE", "2027-12-31"),
    admCg: await seedCredential(A.admCg, "PROFESSIONAL_LICENSE", "2027-12-31"),
    supCg: await seedCredential(A.supCg, "PROFESSIONAL_LICENSE", "2027-12-31"),
  };
  for (const p of [A.cg, A.cg2, A.admCg, A.supCg]) await seedCredential(p, "CPR", "2027-12-31");
  const rsC = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id,worker_role,name) VALUES ($1,'CNA','Requisitos CNA') RETURNING id`, [orgC])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id,credential_type_id,is_mandatory,requires_organization_review) VALUES ($1,$2,true,true)`, [rsC, await typeId("PROFESSIONAL_LICENSE")]);
  const licC = { admCg: await seedCredential(C.admCg, "PROFESSIONAL_LICENSE", "2027-12-31"), cg: await seedCredential(C.cg, "PROFESSIONAL_LICENSE", "2027-12-31") };
  await seedCredential(estAdmin, "PROFESSIONAL_LICENSE", "2027-12-31");
  // History before 149: a self-approval recorded earlier stays as it is (no retroactive change).
  await q(`INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved','2026-10-01')`, [lic.cg2, orgA, A.cg2.userId]);

  const review = (who: P, owner: P, cred: string, reviewStatus: string, notes?: string) =>
    call("POST", `/organizations/${orgA}/workers/${owner.owmId}/credentials/${cred}/review`, who.token, { reviewStatus, ...(notes ? { notes } : {}) });
  const eligibility = async (owner: P) => (await call("GET", `/organizations/${orgA}/workers/${owner.owmId}/compliance`, A.adm.token)).body;
  const licStatus = (e: Json) => e.requirements?.find((r: Json) => r.requirement === "PROFESSIONAL_LICENSE")?.status;
  const W = (p: P) => `/organizations/${orgA}/workers/${p.workerId}/credentials`;
  const pdf = Buffer.from(`%PDF-1.4 sintetico ${tag}\n%%EOF`);

  try {
    // ------------------------------------------------------------ no retroactive change
    const eLegacy = await eligibility(A.cg2);
    check("T0 no retroactive change: a credential approved before 149 (even a self-approval recorded earlier) keeps its approval and the person stays eligible",
      eLegacy.eligibility === "eligible" && licStatus(eLegacy) === "satisfied", `${eLegacy.eligibility}/${licStatus(eLegacy)}`);

    // ------------------------------------------------------------ 4 + 9: positive control
    const okCg = await review(A.adm, A.cg, lic.cg, "approved");
    const e0 = await eligibility(A.cg);
    check("C0 control: an administrator approves another person's credential (200) and the caregiver becomes eligible under the agency's own policy",
      okCg.status === 200 && e0.eligibility === "eligible", `${okCg.status} ${e0.eligibility}`);

    // ------------------------------------------------------------ 1: caregiver cannot regain eligibility by herself
    await q(`UPDATE credentials SET expires_at = current_date - 1 WHERE id=$1`, [lic.cg]); // time passes (fixture)
    const e1 = await eligibility(A.cg);
    const viaPatchDate = await call("PATCH", `${W(A.cg)}/${lic.cg}`, A.cg.token, { expiresAt: "2030-01-01" });
    const viaPatchStatus = await call("PATCH", `${W(A.cg)}/${lic.cg}`, A.cg.token, { status: "active", expiresAt: null });
    const viaCreate = await call("POST", W(A.cg), A.cg.token, { credentialTypeCode: "PROFESSIONAL_LICENSE", issuingEntityType: "government", expiresAt: "2030-01-01" });
    const viaCreateCpr = await call("POST", W(A.cg), A.cg.token, { credentialTypeCode: "CPR", issuingEntityType: "external_provider", expiresAt: "2030-01-01" });
    const viaReview = await review(A.cg, A.cg, lic.cg, "approved");
    const dbUpdate = await rt(A.cg.userId, orgA, `UPDATE credentials SET expires_at='2030-01-01' WHERE id=$1`, [lic.cg]);
    const dbStatus = await rt(A.cg.userId, orgA, `UPDATE credentials SET status='active', issued_at=current_date WHERE id=$1`, [lic.cg]);
    const dbInsert = await rt(A.cg.userId, orgA, `INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status,expires_at) VALUES ($1,$2,'government','active','2030-01-01')`, [A.cg.workerId, await typeId("PROFESSIONAL_LICENSE")]);
    const dbDelete = await rt(A.cg.userId, orgA, `DELETE FROM credentials WHERE id=$1`, [lic.cg]);
    const dbReview = await rt(A.cg.userId, orgA, `UPDATE organization_credential_reviews SET review_status='approved', reviewed_by_user_id=$2, reviewed_at=now() WHERE credential_id=$1`, [lic.cg, A.cg.userId]);
    const e1b = await eligibility(A.cg);
    const dateAfter = (await q<Json>(`SELECT expires_at::text d FROM credentials WHERE id=$1`, [lic.cg])).rows[0].d;
    check("T1a caregiver with an expired approved licence: API PATCH date/status, POST new licence or CPR, and self-review are all 403; nothing changes",
      e1.eligibility === "not_eligible" && licStatus(e1) === "CREDENTIAL_EXPIRED"
        && [viaPatchDate, viaPatchStatus, viaCreate, viaCreateCpr, viaReview].every((r) => r.status === 403)
        && e1b.eligibility === "not_eligible" && dateAfter < new Date().toISOString().slice(0, 10),
      `before=${e1.eligibility}/${licStatus(e1)} patch=${viaPatchDate.status}/${viaPatchStatus.status} create=${viaCreate.status}/${viaCreateCpr.status} review=${viaReview.status}(${viaReview.body.error}) after=${e1b.eligibility} date=${dateAfter}`);
    check("T1b same caregiver straight to the database as app_runtime: UPDATE date, UPDATE status, INSERT, DELETE of her credential and approving her review are refused (42501)",
      [dbUpdate, dbStatus, dbInsert, dbDelete].every((r) => r.code === "42501" && /CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN/.test(r.message)) && (dbReview.code !== null || dbReview.rowCount === 0),
      `upd=${dbUpdate.code} status=${dbStatus.code} ins=${dbInsert.code} del=${dbDelete.code} review=${dbReview.code ?? `rows=${dbReview.rowCount}`}`);

    // Evidence stays open: the caregiver uploads a renewed licence; the review goes back to pending.
    await q(`UPDATE credentials SET expires_at = '2028-06-30' WHERE id=$1`, [lic.cg]); // the agency records the new date later; here, a fixture
    const init = await call("POST", `/organizations/${orgA}/me/credentials/${lic.cg}/documents/upload-url`, A.cg.token, { originalFilename: "licencia-renovada.pdf", contentType: "application/pdf", sizeBytes: pdf.byteLength });
    const fileId = init.body.upload?.fileId;
    const put = fileId ? await call("POST", `/organizations/${orgA}/me/credentials/${lic.cg}/documents/${fileId}/content`, A.cg.token, pdf, "application/pdf") : { status: 0, body: {} };
    const done = fileId ? await call("POST", `/organizations/${orgA}/me/credentials/${lic.cg}/documents/${fileId}/complete`, A.cg.token) : { status: 0, body: {} };
    const afterUpload = (await q<Json>(`SELECT review_status FROM organization_credential_reviews WHERE credential_id=$1 AND organization_id=$2`, [lic.cg, orgA])).rows[0];
    const e1c = await eligibility(A.cg);
    const reApprove = await review(A.sup, A.cg, lic.cg, "approved");
    const e1d = await eligibility(A.cg);
    check("T1c evidence stays open and needs a new review: the caregiver uploads a renewed licence (201/200/200), the review returns to pending, she stays not eligible until a supervisor approves it",
      init.status === 201 && put.status === 200 && done.status === 200 && afterUpload?.review_status === "pending"
        && e1c.eligibility === "not_eligible" && licStatus(e1c) === "ORGANIZATION_REVIEW_MISSING" && reApprove.status === 200 && e1d.eligibility === "eligible",
      `upload=${init.status}/${put.status}/${done.status} review=${afterUpload?.review_status} mid=${e1c.eligibility}/${licStatus(e1c)} approve=${reApprove.status} end=${e1d.eligibility}`);

    // ------------------------------------------------------------ 2 + 3: admin-caregiver and supervisor-caregiver
    for (const [label, me, cred] of [["T2 administrator-caregiver", A.admCg, lic.admCg], ["T3 supervisor-caregiver", A.supCg, lic.supCg]] as const) {
      const approveOwn = await review(me, me, cred, "approved");
      const rejectOwn = await review(me, me, cred, "rejected", "x");
      const editOwn = await call("PATCH", `${W(me)}/${cred}`, me.token, { expiresAt: "2031-01-01" });
      const createOwn = await call("POST", W(me), me.token, { credentialTypeCode: "PROFESSIONAL_LICENSE", issuingEntityType: "government", expiresAt: "2031-01-01" });
      const queue = await call("GET", `/organizations/${orgA}/credentials/review-queue`, me.token);
      const ownInQueue = (queue.body.items ?? queue.body.reviews ?? queue.body.queue ?? []).some((i: Json) => i.credentialId === cred);
      const dbIns = await rt(me.userId, orgA, `INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [cred, orgA, me.userId]);
      const dbOdvr = await rt(me.userId, orgA, `INSERT INTO organization_document_version_reviews (organization_id,credential_id,document_id,file_id,review_status,reviewed_by_user_id) SELECT $2,c.id,c.document_id,d.file_id,'approved',$3 FROM credentials c JOIN documents d ON d.id=c.document_id WHERE c.id=$1`, [cred, orgA, me.userId]);
      const dbEdit = await rt(me.userId, orgA, `UPDATE credentials SET expires_at='2031-01-01' WHERE id=$1`, [cred]);
      const reviewed = Number((await q(`SELECT count(*) n FROM organization_credential_reviews WHERE credential_id=$1`, [cred])).rows[0].n);
      const e = await eligibility(me);
      check(`${label}: approving or rejecting her own credential 403 (CREDENTIAL_SELF_REVIEW_FORBIDDEN), editing/creating her own 403; it is not in her queue; the database refuses the same writes; still not eligible`,
        approveOwn.status === 403 && approveOwn.body.error === "CREDENTIAL_SELF_REVIEW_FORBIDDEN" && rejectOwn.status === 403
          && editOwn.status === 403 && editOwn.body.error === "CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN" && createOwn.status === 403
          && queue.status === 200 && !ownInQueue
          && dbIns.code === "42501" && /SELF_REVIEW/.test(dbIns.message) && dbOdvr.code === "42501" && /SELF_REVIEW/.test(dbOdvr.message)
          && dbEdit.code === "42501" && /SELF_MANAGEMENT/.test(dbEdit.message) && reviewed === 0 && e.eligibility === "not_eligible",
        `approve=${approveOwn.status}/${approveOwn.body.error} reject=${rejectOwn.status} edit=${editOwn.status}/${editOwn.body.error} create=${createOwn.status} queue=${queue.status}/own=${ownInQueue} db=${dbIns.code}/${dbOdvr.code}/${dbEdit.code} rows=${reviewed} elig=${e.eligibility}`);
    }

    // ------------------------------------------------------------ 4: authorised staff review other people
    const q1 = await call("GET", `/organizations/${orgA}/credentials/review-queue`, A.adm.token);
    const inAdmQueue = (q1.body.items ?? q1.body.reviews ?? q1.body.queue ?? []).filter((i: Json) => [lic.admCg, lic.supCg].includes(i.credentialId)).length;
    const r1 = await review(A.supCg, A.admCg, lic.admCg, "approved");
    const r2 = await review(A.admCg, A.supCg, lic.supCg, "rejected", "Ilegible");
    const r3 = await review(A.adm, A.supCg, lic.supCg, "approved");
    const managerEdit = await call("PATCH", `${W(A.cg)}/${lic.cg}`, A.adm.token, { expiresAt: "2028-12-31" });
    const managerCreate = await call("POST", W(A.cg2), A.sup.token, { credentialTypeCode: "BLS", issuingEntityType: "external_provider", expiresAt: "2028-12-31" });
    const [ea, es] = [await eligibility(A.admCg), await eligibility(A.supCg)];
    const audit = Number((await q(`SELECT count(*) n FROM organization_document_version_reviews WHERE credential_id = ANY($1)`, [[lic.admCg, lic.supCg]])).rows[0].n);
    check("T4 authorised staff of the same agency review other people's credentials: supervisor-caregiver approves the admin-caregiver, admin-caregiver rejects the supervisor-caregiver, an admin approves it; their own credentials are in another manager's queue; managers still edit/create others' credentials; every decision leaves an audit row",
      inAdmQueue === 2 && r1.status === 200 && r2.status === 200 && r3.status === 200 && managerEdit.status === 200 && managerCreate.status === 201
        && ea.eligibility === "eligible" && es.eligibility === "eligible" && audit === 3,
      `queue=${inAdmQueue} r=${r1.status}/${r2.status}/${r3.status} edit=${managerEdit.status} create=${managerCreate.status} elig=${ea.eligibility}/${es.eligibility} audit=${audit}`);

    // ------------------------------------------------------------ role changes
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='SUPERVISOR'`, [A.cg.membershipId, orgA]);
    const promotedSelf = await review(A.cg, A.cg, lic.cg, "approved");
    const promotedOther = await review(A.cg, A.cg2, lic.cg2, "approved");
    await q(`DELETE FROM user_roles WHERE organization_membership_id=$1 AND role_id=(SELECT id FROM roles WHERE code='ORGANIZATION_ADMIN')`, [A.admCg.membershipId]);
    const demoted = await review(A.admCg, A.cg2, lic.cg2, "rejected", "x");
    const demotedEdit = await call("PATCH", `${W(A.cg2)}/${lic.cg2}`, A.admCg.token, { expiresAt: "2029-01-01" });
    check("R1 role changes: a caregiver promoted to supervisor still cannot review her own credential (403) but can review a colleague's (200); an administrator who loses the role can no longer review or edit others (403)",
      promotedSelf.status === 403 && promotedSelf.body.error === "CREDENTIAL_SELF_REVIEW_FORBIDDEN" && promotedOther.status === 200 && demoted.status === 403 && demotedEdit.status === 403,
      `self=${promotedSelf.status} other=${promotedOther.status} demoted=${demoted.status}/${demotedEdit.status}`);

    // ------------------------------------------------------------ 6: other agency and ETNARA Central
    const bReview = await call("POST", `/organizations/${orgA}/workers/${A.cg.owmId}/credentials/${lic.cg}/review`, B.adm.token, { reviewStatus: "rejected", notes: "x" });
    const bReviewOwnPath = await call("POST", `/organizations/${orgB}/workers/${A.cg.owmId}/credentials/${lic.cg}/review`, B.adm.token, { reviewStatus: "rejected", notes: "x" });
    const bList = await call("GET", `/organizations/${orgB}/workers/${A.cg.workerId}/credentials`, B.adm.token);
    const bEdit = await call("PATCH", `/organizations/${orgB}/workers/${A.cg.workerId}/credentials/${lic.cg}`, B.adm.token, { expiresAt: "2035-01-01" });
    const bForgedRead = await rt(B.adm.userId, orgA, `SELECT count(*)::int n FROM credentials WHERE worker_id=$1`, [A.cg.workerId]);
    const bForgedReview = await rt(B.adm.userId, orgA, `INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [lic.cg2, orgA, B.adm.userId]);
    const bForgedEdit = await rt(B.adm.userId, orgB, `UPDATE credentials SET expires_at='2035-01-01' WHERE id=$1`, [lic.cg]);
    check("T6 agency B: review through A's path 403, through its own path 404, list/edit A's caregiver 404; at the database (own and forged context) it reads 0 rows, cannot approve and cannot edit",
      bReview.status === 403 && bReviewOwnPath.status === 404 && bList.status === 404 && bEdit.status === 404
        && (bForgedRead.code !== null || Number(bForgedRead.rows[0]?.n) === 0) && bForgedReview.code === "42501" && (bForgedEdit.code !== null || bForgedEdit.rowCount === 0),
      `review=${bReview.status}/${bReviewOwnPath.status} list=${bList.status} edit=${bEdit.status} forgedRead=${bForgedRead.code ?? bForgedRead.rows[0]?.n} forgedReview=${bForgedReview.code} forgedEdit=${bForgedEdit.code ?? bForgedEdit.rowCount}`);
    const cReview = await rt(platform.userId, "", `INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [lic.cg2, orgA, platform.userId], true);
    const cReviewUpd = await rt(platform.userId, "", `UPDATE organization_credential_reviews SET review_status='approved', reviewed_by_user_id=$2 WHERE credential_id=$1`, [lic.cg2, platform.userId], true);
    const cEdit = await rt(platform.userId, "", `UPDATE credentials SET expires_at='2035-01-01' WHERE id=$1`, [lic.cg], true);
    const cCreate = await rt(platform.userId, "", `INSERT INTO credentials (worker_id,credential_type_id,issuing_entity_type,status) VALUES ($1,$2,'platform','active')`, [A.cg.workerId, await typeId("BLS")], true);
    const cApi = await call("POST", `/organizations/${orgA}/workers/${A.cg.owmId}/credentials/${lic.cg}/review`, platform.token, { reviewStatus: "approved" });
    check("T6b ETNARA Central (verified platform admin) cannot approve credentials of an agency by API (403) or with ordinary database access (insert/update review 42501 or 0 rows), nor edit (0 rows: it no longer sees them) or create credentials (42501)",
      cApi.status === 403 && cReview.code === "42501" && (cReviewUpd.code !== null || cReviewUpd.rowCount === 0) && (cEdit.code === "42501" || cEdit.rowCount === 0) && cCreate.code === "42501",
      `api=${cApi.status} review=${cReview.code}/${cReviewUpd.code ?? cReviewUpd.rowCount} edit=${cEdit.code} create=${cCreate.code}`);

    // ------------------------------------------------------------ Central: credential data closed too (E2)
    const cRead = await rt(platform.userId, "", `SELECT (SELECT count(*) FROM credentials)::int c, (SELECT count(*) FROM organization_credential_reviews)::int r, (SELECT count(*) FROM organization_document_version_reviews)::int v, (SELECT count(*) FROM credential_platform_verifications)::int p`, [], true);
    const cForged = await rt(platform.userId, orgA, `SELECT count(*)::int n FROM credentials WHERE worker_id=$1`, [A.cg.workerId], true);
    const cCpv = await rt(platform.userId, "", `INSERT INTO credential_platform_verifications (credential_id,status,verified_by_user_id) VALUES ($1,'verified',$2)`, [lic.cg, platform.userId], true);
    const cOdvr = await rt(platform.userId, "", `INSERT INTO organization_document_version_reviews (organization_id,credential_id,document_id,file_id,review_status,reviewed_by_user_id) SELECT $2,c.id,c.document_id,d.file_id,'approved',$3 FROM credentials c JOIN documents d ON d.id=c.document_id WHERE c.id=$1`, [lic.cg, orgA, platform.userId], true);
    const cSummary = await call("GET", `/platform/organizations/${orgA}/credentials`, platform.token);
    const nonPlatformSummary = await call("GET", `/platform/organizations/${orgA}/credentials`, A.adm.token);
    check("T6c E2: ETNARA Central reads 0 credentials, reviews, version reviews and platform verifications (with and without a forged agency context) and cannot write any; the residual summary route answers 200 with summary null (no data), 403 for non-platform users",
      cRead.code === null && cRead.rows[0].c === 0 && cRead.rows[0].r === 0 && cRead.rows[0].v === 0 && cRead.rows[0].p === 0 && cForged.rows[0]?.n === 0
        && cCpv.code === "42501" && (cOdvr.code === "42501" || cOdvr.rowCount === 0)
        && cSummary.status === 200 && cSummary.body.summary === null && cSummary.body.accessModel === "AGENCY_RESPONSIBILITY" && nonPlatformSummary.status === 403,
      `read=${JSON.stringify(cRead.rows[0] ?? cRead.code)} forged=${cForged.rows[0]?.n ?? cForged.code} cpv=${cCpv.code} odvr=${cOdvr.code ?? cOdvr.rowCount} summary=${cSummary.status}/${JSON.stringify(cSummary.body)} nonPlatform=${nonPlatformSummary.status}`);

    // ------------------------------------------------------------ other effective roles
    const famApi = await review(family, A.cg2, lic.cg2, "rejected", "x");
    const famEdit = await call("PATCH", `${W(A.cg2)}/${lic.cg2}`, family.token, { expiresAt: "2030-01-01" });
    const famDb = await rt(family.userId, orgA, `INSERT INTO organization_credential_reviews (credential_id,organization_id,reviewed_by_user_id,review_status,reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [lic.supCg, orgA, family.userId]);
    const famCred = await rt(family.userId, orgA, `UPDATE credentials SET expires_at='2030-01-01' WHERE id=$1`, [lic.cg2]);
    const estApi = await review(estAdmin, A.cg2, lic.cg2, "rejected", "x");
    const estEdit = await call("PATCH", `${W(A.cg2)}/${lic.cg2}`, estAdmin.token, { expiresAt: "2030-01-01" });
    const estDb = await rt(estAdmin.userId, orgA, `UPDATE credentials SET expires_at='2030-01-01' WHERE id=$1`, [lic.cg2]);
    const estOwn = await rt(estAdmin.userId, orgA, `UPDATE credentials SET expires_at='2030-01-01' WHERE worker_id=$1`, [estAdmin.workerId]);
    check("R2 other effective roles: a relative and an establishment administrator cannot review or edit credentials by API (403/404) nor at the database (42501 or 0 rows), including the establishment administrator's own",
      [famApi, famEdit, estApi, estEdit].every((r) => r.status === 403 || r.status === 404)
        && (famDb.code === "42501") && (famCred.code === "42501" || famCred.rowCount === 0) && estDb.code === "42501" && estOwn.code === "42501",
      `family=${famApi.status}/${famEdit.status}/${famDb.code}/${famCred.code ?? famCred.rowCount} estAdmin=${estApi.status}/${estEdit.status}/${estDb.code}/${estOwn.code}`);

    // ------------------------------------------------------------ 5: small agency, delegation (no ETNARA Central)
    const eligC = async (owner: P) => (await call("GET", `/organizations/${orgC}/workers/${owner.owmId}/compliance`, C.admCg.token)).body;
    const reviewC = (who: P, owner: P, cred: string, reviewStatus: string) => call("POST", `/organizations/${orgC}/workers/${owner.owmId}/credentials/${cred}/review`, who.token, { reviewStatus });
    const soloSelf = await reviewC(C.admCg, C.admCg, licC.admCg, "approved");
    const soloQueue = await call("GET", `/organizations/${orgC}/credentials/review-queue`, C.admCg.token);
    const soloOwnInQueue = (soloQueue.body.items ?? []).some((i: Json) => i.credentialId === licC.admCg);
    const beforeDelegation = await eligC(C.admCg);
    const cgBefore = await reviewC(C.cg, C.admCg, licC.admCg, "approved");
    const delegate = await call("POST", `/organizations/${orgC}/team/roles`, C.admCg.token, { workerMembershipId: C.cg.owmId, role: "SUPERVISOR", enabled: true });
    const delegatedQueue = await call("GET", `/organizations/${orgC}/credentials/review-queue`, C.cg.token);
    const inDelegateQueue = (delegatedQueue.body.items ?? []).some((i: Json) => i.credentialId === licC.admCg);
    const delegatedApprove = await reviewC(C.cg, C.admCg, licC.admCg, "approved");
    const afterDelegation = await eligC(C.admCg);
    const delegateSelf = await reviewC(C.cg, C.cg, licC.cg, "approved");
    const adminApprovesDelegate = await reviewC(C.admCg, C.cg, licC.cg, "approved");
    const centralC = await call("POST", `/organizations/${orgC}/workers/${C.admCg.owmId}/credentials/${licC.admCg}/review`, platform.token, { reviewStatus: "approved" });
    const revoke = await call("POST", `/organizations/${orgC}/team/roles`, C.admCg.token, { workerMembershipId: C.cg.owmId, role: "SUPERVISOR", enabled: false });
    const afterRevoke = await call("POST", `/organizations/${orgC}/workers/${C.admCg.owmId}/credentials/${licC.admCg}/review`, C.cg.token, { reviewStatus: "rejected", notes: "prueba" });
    check("T5 small agency whose only administrator is also a caregiver: she cannot approve herself and her credential is not in her queue, so it stays pending (no ETNARA Central involvement possible: 403); she delegates by naming a colleague supervisor (Equipo › rol), who sees it in her queue and approves it; the delegate cannot approve her own (403) but the administrator can; removing the delegation removes the authority (403)",
      soloSelf.status === 403 && !soloOwnInQueue && beforeDelegation.eligibility === "not_eligible" && cgBefore.status === 403
        && delegate.status === 200 && inDelegateQueue && delegatedApprove.status === 200 && afterDelegation.eligibility === "eligible"
        && delegateSelf.status === 403 && adminApprovesDelegate.status === 200 && centralC.status === 403 && revoke.status === 200 && afterRevoke.status === 403,
      `self=${soloSelf.status} ownInQueue=${soloOwnInQueue} before=${beforeDelegation.eligibility} cgBefore=${cgBefore.status} delegate=${delegate.status} inQueue=${inDelegateQueue} approve=${delegatedApprove.status} after=${afterDelegation.eligibility} delegateSelf=${delegateSelf.status} adminApproves=${adminApprovesDelegate.status} central=${centralC.status} revoke=${revoke.status}/${afterRevoke.status}`);

    // ------------------------------------------------------------ 7 + 9: history and eligibility unchanged
    const legacy = (await q<Json>(`SELECT review_status, reviewed_by_user_id FROM organization_credential_reviews WHERE credential_id=$1 AND organization_id=$2`, [lic.cg2, orgA])).rows[0];
    const versions = Number((await q(`SELECT count(*) n FROM document_versions dv JOIN credentials c ON c.document_id=dv.document_id WHERE c.id=$1`, [lic.cg])).rows[0].n);
    check("T7 history: decisions and versions are kept; the review row of the credential reviewed in R1 shows the colleague as author and every earlier decision is still in the audit table",
      legacy?.review_status === "approved" && legacy.reviewed_by_user_id === A.cg.userId && versions === 2,
      `cg2=${legacy?.review_status} by=${legacy?.reviewed_by_user_id === A.cg.userId ? "colleague" : legacy?.reviewed_by_user_id} versions=${versions}`);
    const e9 = await eligibility(A.cg2);
    const noPolicy = await call("GET", `/organizations/${orgB}/workers/${(await person("b-cg", orgB, ["WORKER"], true)).owmId}/compliance`, B.adm.token);
    check("T9 eligibility still uses only the agency's policy and existing validations: CPR without review counts once a manager records it, the licence needs the agency's approval, an agency without a policy stays 'unconfigured'",
      e9.eligibility === "eligible" && e9.requirements?.find((r: Json) => r.requirement === "CPR")?.status === "satisfied" && noPolicy.status === 200 && noPolicy.body.eligibility === "unconfigured",
      `cg2=${e9.eligibility} cpr=${e9.requirements?.find((r: Json) => r.requirement === "CPR")?.status} noPolicy=${noPolicy.status}/${noPolicy.body.eligibility}`);
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await runtime.end().catch(() => undefined);
    await db.end();
    moto.kill();
    Object.assign(console, originals);
  }

  out("\nCredential self-management and self-approval (migration 149)\n");
  out("| Check | Result | Detail |\n|---|---|---|");
  for (const r of results) out(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`);
  const failed = results.filter((r) => !r.pass).length;
  out(`\nCredential self-approval: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

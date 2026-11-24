/**
 * 162 · Una agencia pierde el acceso ordinario a las credenciales y archivos profesionales de una cuidadora que
 * ya no le pertenece, y cada descarga de un documento de credencial queda auditada (usuario, organización,
 * documento, versión y fecha). Datos FICTICIOS, base PROPIA desechable, S3 local (moto), app real por HTTP
 * conectada como app_runtime, más comprobaciones directas en la base.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyFormerAgencyAccessDownloads162.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";

let moto: ChildProcess | null = null;
async function main() {
  const s3Port = Number(process.env.S162_TEST_S3_PORT ?? 4582);
  moto = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  for (let i = 0; i < 50; i++) { try { await realFetch(endpoint); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const bucket = `s162-${randomUUID().slice(0, 8)}`;
  await new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } }).send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, { STORAGE_ENDPOINT: endpoint, STORAGE_REGION: "us-east-1", STORAGE_BUCKET: bucket, STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true" });
  const own = `etnara_s162_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const ownUrl = new URL(serverUrl!); ownUrl.pathname = `/${own}`; const adminUrl = ownUrl.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();
  // Como la aplicación en una petición (mismos ajustes que withTenantContext), dentro de una transacción revertida.
  const asApp = async <T = Json[]>(userId: string | null, orgId: string | null, stmt: string, params: unknown[] = []): Promise<T | string> => {
    try {
      await rt.query("BEGIN");
      if (userId) await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [userId, orgId]);
      const r = await rt.query(stmt, params); await rt.query("ROLLBACK"); return r.rows as T;
    } catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as Error).message; }
  };
  const sqlErr = async (stmt: string) => { try { await q("BEGIN"); await q(stmt); await q("ROLLBACK"); return "OK"; } catch (e) { await q("ROLLBACK").catch(() => undefined); return (e as Error).message; } };

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const errors500: string[] = [];
  let expect500 = false;
  async function call(method: string, path: string, token: string, body?: Json | Buffer) {
    const isBuf = Buffer.isBuffer(body);
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": isBuf ? "application/pdf" : "application/json" } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
    const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 40) }; }
    if (res.status >= 500 && !expect500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json };
  }
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const user = async (key: string) => { const email = `s162-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const typeCode = (await q<{ code: string }>(`SELECT code FROM credential_types ORDER BY code LIMIT 1`)).rows[0].code;
  const events = async (where = "TRUE", p: unknown[] = []) => Number((await q<{ n: string }>(`SELECT count(*) n FROM credential_document_downloads WHERE ${where}`, p)).rows[0].n);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

  // ---- Base ficticia: dos agencias donde trabaja María, una sin relación, personal de A ----------------------------
  const A = await org(`Agencia A ${tag}`), B = await org(`Agencia B ${tag}`), C = await org(`Agencia C ${tag}`);
  const adminA = await user("admin-a"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const supA = await user("sup-a"); await member(supA, A, ["SUPERVISOR"]);
  const adminB = await user("admin-b"); await member(adminB, B, ["ORGANIZATION_ADMIN"]);
  const adminC = await user("admin-c"); await member(adminC, C, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const otra = await user("otra"); await member(otra, A, ["WORKER"]);
  const otraW = (await q<{ id: string }>(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [otra.id])).rows[0].id;
  await q(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA')`, [otraW, A]);
  const maria = await user("maria"); await member(maria, A, ["WORKER"]); await member(maria, B, ["WORKER"]);
  const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,'María Ficticia') RETURNING id`, [maria.id])).rows[0].id;
  const memA = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [w, A])).rows[0].id;
  const memB = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [w, B])).rows[0].id;
  const tA = await login(adminA, A), tSupA = await login(supA, A), tB = await login(adminB, B), tC = await login(adminC, C);
  const tOtra = await login(otra, A), tMariaA = await login(maria, A);

  // La agencia A registra la credencial de María y sube el archivo con el almacenamiento seguro existente.
  const cred = await call("POST", `/organizations/${A}/workers/${w}/credentials`, tA, { credentialTypeCode: typeCode, issuingEntityType: "government", expiresAt: "2030-01-01" });
  const credId = (cred.body.credential ?? cred.body).id as string;
  const init = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/upload-url`, tA, { originalFilename: "licencia.pdf", contentType: "application/pdf", sizeBytes: pdf.byteLength });
  const fileId = init.body.upload?.fileId as string;
  const put = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/content`, tA, pdf);
  const done = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/complete`, tA);
  const review = await call("POST", `/organizations/${A}/workers/${memA}/credentials/${credId}/review`, tSupA, { reviewStatus: "approved" });
  check("D0. Preparación: credencial, archivo (S3 privado) y revisión aprobada por la agencia A",
    [200, 201].includes(cred.status) && init.status === 201 && put.status === 200 && done.status === 200 && [200, 201].includes(review.status),
    [cred.status, init.status, put.status, done.status, review.status, review.body]);

  // ---- 1. Membresía activa: el acceso de hoy se mantiene, y cada descarga queda registrada ----------------------
  const listActive = await call("GET", `/organizations/${A}/workers/${w}/credentials`, tA);
  const dlAdmin = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tA, {});
  const ev1 = (await q(`SELECT user_id, organization_id, worker_id, credential_id, document_id, document_version_id, file_id, actor_kind, occurred_at FROM credential_document_downloads WHERE user_id=$1`, [adminA.id])).rows;
  const docRow = (await q<{ document_id: string }>(`SELECT document_id FROM credentials WHERE id=$1`, [credId])).rows[0];
  const verRow = (await q<{ id: string }>(`SELECT id FROM document_versions WHERE document_id=$1 AND file_id=$2`, [docRow.document_id, fileId])).rows[0];
  check("D1. Membresía activa: la agencia ve la credencial y descarga el archivo, como hoy",
    listActive.status === 200 && listActive.body.credentials?.length === 1 && dlAdmin.status === 200 && typeof dlAdmin.body.download?.downloadUrl === "string",
    [listActive.status, listActive.body.credentials?.length, dlAdmin.status]);
  const e = ev1[0] as Json | undefined;
  check("D2. La descarga queda auditada: usuario, organización, cuidadora, credencial, documento, versión, archivo y fecha",
    ev1.length === 1 && e?.organization_id === A && e?.worker_id === w && e?.credential_id === credId && e?.document_id === docRow.document_id
    && e?.document_version_id === verRow?.id && e?.file_id === fileId && e?.actor_kind === "AGENCY_MANAGER"
    && Math.abs(new Date(e?.occurred_at).getTime() - Date.now()) < 120_000, ev1);
  const dlSelf = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tMariaA, {});
  check("D3. La propia cuidadora descarga su archivo; queda auditado como CAREGIVER_SELF",
    dlSelf.status === 200 && await events(`user_id=$1 AND actor_kind='CAREGIVER_SELF'`, [maria.id]) === 1, [dlSelf.status]);
  const before = await events();
  const dlOtra = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tOtra, {});
  const dlC = await call("POST", `/organizations/${C}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tC, {});
  const dlCasA = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tC, {});
  check("D4. Otra cuidadora de A y una agencia sin relación no descargan (403/404) y no se registra nada",
    [403, 404].includes(dlOtra.status) && [403, 404].includes(dlC.status) && [403, 404].includes(dlCasA.status) && await events() === before,
    [dlOtra.status, dlC.status, dlCasA.status]);

  // ---- 2. María deja de pertenecer a la agencia A ------------------------------------------------------------------
  const deact = await call("PATCH", `/organizations/${A}/workers/${memA}`, tA, { status: "inactive" });
  const staff = await call("GET", `/organizations/${A}/workers`, tA);
  const listInactive = await call("GET", `/organizations/${A}/workers/${w}/credentials`, tA);
  const listInactiveSup = await call("GET", `/organizations/${A}/workers/${w}/credentials`, tSupA);
  const staffRow = (staff.body.memberships as Json[] | undefined)?.find((r) => r.id === memA);
  check("D5. Tras la baja la agencia A conserva el perfil (lista de personal), pero ya no recibe credenciales (backend)",
    deact.status === 200 && Boolean(staffRow) && listInactive.status === 200 && listInactive.body.credentials?.length === 0
    && listInactiveSup.status === 200 && listInactiveSup.body.credentials?.length === 0,
    [deact.status, Boolean(staffRow), listInactive.status, listInactive.body, listInactiveSup.body]);
  const beforeDl = await events();
  const dlAfter = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tA, {});
  const dlAfterSup = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tSupA, {});
  check("D6. Tras la baja la agencia A no descarga el archivo (404 sin señal de existencia) y no se registra descarga",
    dlAfter.status === 404 && dlAfterSup.status === 404 && !dlAfter.body.download && await events() === beforeDl, [dlAfter.status, dlAfterSup.status]);
  const rlsA = await asApp<Json[]>(adminA.id, A, `SELECT
      (SELECT count(*) FROM workers WHERE id=$1)::int AS perfil,
      (SELECT count(*) FROM credentials WHERE worker_id=$1)::int AS credenciales,
      (SELECT count(*) FROM documents WHERE worker_id=$1)::int AS documentos,
      (SELECT count(*) FROM document_versions WHERE document_id=$2)::int AS versiones,
      (SELECT count(*) FROM stored_files WHERE id=$3)::int AS archivos`, [w, docRow.document_id, fileId]);
  const r0 = Array.isArray(rlsA) ? rlsA[0] : {};
  check("D7. Base de datos (app_runtime, sin el backend): la agencia A ve el perfil y 0 credenciales, documentos, versiones y archivos",
    r0.perfil === 1 && r0.credenciales === 0 && r0.documentos === 0 && r0.versiones === 0 && r0.archivos === 0, rlsA);
  const fnA = await asApp(adminA.id, A, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, fileId]);
  check("D8. Base de datos: la función de descarga rechaza a la agencia anterior aunque se la llame directamente", String(fnA).includes("DOWNLOAD_NOT_ALLOWED"), fnA);
  const reviewsKept = (await q<{ n: string }>(`SELECT count(*) n FROM organization_credential_reviews WHERE organization_id=$1 AND credential_id=$2 AND review_status='approved'`, [A, credId])).rows[0].n;
  const reviewsSeenByA = await asApp<Json[]>(adminA.id, A, `SELECT count(*)::int n FROM organization_credential_reviews WHERE credential_id=$1`, [credId]);
  const auditKept = await events(`organization_id=$1`, [A]);
  check("D9. Se conservan los registros históricos: la revisión de A sigue guardada (y visible para A bajo su propia regla) y su registro de descargas también",
    Number(reviewsKept) === 1 && Array.isArray(reviewsSeenByA) && reviewsSeenByA[0].n === 1 && auditKept === 2, [reviewsKept, reviewsSeenByA, auditKept]);

  // ---- 3. Membresía activa en B: sin cambios -------------------------------------------------------------------------
  const listB = await call("GET", `/organizations/${B}/workers/${w}/credentials`, tB);
  const dlB = await call("POST", `/organizations/${B}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tB, {});
  check("D10. La agencia B (membresía activa) sigue viendo y descargando; la descarga queda auditada en B",
    listB.status === 200 && listB.body.credentials?.length === 1 && dlB.status === 200 && await events(`organization_id=$1 AND user_id=$2`, [B, adminB.id]) === 1,
    [listB.status, listB.body.credentials?.length, dlB.status]);
  const ownB = await asApp<Json[]>(maria.id, B, `SELECT (SELECT count(*) FROM credentials WHERE worker_id=$1)::int c, (SELECT count(*) FROM stored_files WHERE id=$2)::int f`, [w, fileId]);
  check("D11. La propia cuidadora sigue viendo sus credenciales y archivos", Array.isArray(ownB) && ownB[0].c === 1 && ownB[0].f === 1, ownB);

  // ---- 4. El registro de descargas: solo lectura para la agencia correspondiente; nadie lo altera --------------------
  const seeA = await asApp<Json[]>(adminA.id, A, `SELECT organization_id FROM credential_document_downloads`);
  const seeB = await asApp<Json[]>(adminB.id, B, `SELECT organization_id FROM credential_document_downloads`);
  const seeOtra = await asApp<Json[]>(otra.id, A, `SELECT 1 FROM credential_document_downloads`);
  const seeC = await asApp<Json[]>(adminC.id, A, `SELECT 1 FROM credential_document_downloads`);
  check("D12. Cada agencia ve solo sus propias descargas; cuidadoras y otras agencias no ven nada",
    Array.isArray(seeA) && seeA.length === 2 && seeA.every((r) => r.organization_id === A) && Array.isArray(seeB) && seeB.length === 1 && seeB[0].organization_id === B
    && Array.isArray(seeOtra) && seeOtra.length === 0 && Array.isArray(seeC) && seeC.length === 0,
    [Array.isArray(seeA) ? seeA.length : seeA, Array.isArray(seeB) ? seeB.length : seeB, seeOtra, seeC]);
  const rtIns = await asApp(adminA.id, A, `INSERT INTO credential_document_downloads (user_id,organization_id,worker_id,credential_id,document_id,document_version_id,file_id,actor_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,'AGENCY_MANAGER')`, [adminA.id, A, w, credId, docRow.document_id, verRow.id, fileId]);
  const rtUpd = await asApp(adminA.id, A, `UPDATE credential_document_downloads SET user_id=user_id`);
  const rtDel = await asApp(adminA.id, A, `DELETE FROM credential_document_downloads`);
  const suUpd = await sqlErr(`UPDATE credential_document_downloads SET occurred_at = now() - interval '1 year'`);
  const suDel = await sqlErr(`DELETE FROM credential_document_downloads`);
  const suTrunc = await sqlErr(`TRUNCATE credential_document_downloads`);
  check("D13. Solo añadir: la aplicación no puede insertar, cambiar ni borrar eventos; ni siquiera el propietario cambia, borra o vacía la tabla",
    /permission denied/.test(String(rtIns)) && /permission denied/.test(String(rtUpd)) && /permission denied/.test(String(rtDel))
    && [suUpd, suDel, suTrunc].every((x) => x.includes("DOWNLOAD_AUDIT_APPEND_ONLY")), [rtIns, rtUpd, rtDel, suUpd, suDel, suTrunc]);

  // ---- 5. Sin registro no hay URL (fail-closed) -----------------------------------------------------------------------
  await q(`CREATE FUNCTION pg_temp_fail_162() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SIMULATED_AUDIT_FAILURE'; END $$`);
  await q(`CREATE TRIGGER zz_fail_162 BEFORE INSERT ON credential_document_downloads FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_162()`);
  const beforeFail = await events();
  expect500 = true;
  const dlFail = await call("POST", `/organizations/${B}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tB, {});
  expect500 = false;
  await q(`DROP TRIGGER zz_fail_162 ON credential_document_downloads`); await q(`DROP FUNCTION pg_temp_fail_162()`);
  check("D14. Si el registro de la descarga falla, no se entrega ninguna URL", dlFail.status === 500 && !dlFail.body.download && await events() === beforeFail, [dlFail.status, dlFail.body]);

  // ---- 6. La función, fuera de su contexto ---------------------------------------------------------------------------
  const noCtx = await asApp(null, null, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, fileId]);
  const fakeOrg = await asApp(adminC.id, B, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, fileId]);
  const coworker = await asApp(otra.id, A, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, fileId]);
  const platform = await asApp(central.id, B, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, fileId]);
  const wrongFile = await asApp(adminB.id, B, `SELECT * FROM public.app_issue_credential_document_download($1,$2,$3)`, [w, credId, randomUUID()]);
  const def = (await q(`SELECT prosecdef, proconfig::text AS cfg FROM pg_proc WHERE proname='app_issue_credential_document_download'`)).rows[0];
  const pub = (await q(`SELECT has_function_privilege('pg_monitor','public.app_issue_credential_document_download(uuid,uuid,uuid)','EXECUTE') AS p`)).rows[0].p;
  check("D15. Función de descarga: sin contexto, agencia fingida, otra cuidadora, administración de plataforma y archivo ajeno → rechazo; sin EXECUTE público; search_path fijo",
    String(noCtx).includes("DOWNLOAD_CONTEXT_REQUIRED") && String(fakeOrg).includes("DOWNLOAD_NOT_ALLOWED") && String(coworker).includes("DOWNLOAD_NOT_ALLOWED")
    && String(platform).includes("DOWNLOAD_NOT_ALLOWED") && String(wrongFile).includes("DOWNLOAD_FILE_NOT_FOUND")
    && pub === false && def.prosecdef === true && /search_path=pg_catalog, public/.test(def.cfg), [noCtx, fakeOrg, coworker, platform, wrongFile, pub, def]);
  const policies = (await q(`SELECT tablename FROM pg_policies WHERE policyname LIKE '%_manager_read_any_status' ORDER BY 1`)).rows.map((r) => r.tablename);
  check("D16. Solo queda la excepción del perfil (workers); credenciales, documentos y versiones vuelven a exigir membresía activa", JSON.stringify(policies) === '["workers"]', policies);

  // ---- 7. Reactivación: el acceso vuelve sin pérdida de datos ----------------------------------------------------------
  const react = await call("PATCH", `/organizations/${A}/workers/${memA}`, tA, { status: "active" });
  const listBack = await call("GET", `/organizations/${A}/workers/${w}/credentials`, tA);
  const dlBack = await call("POST", `/organizations/${A}/workers/${w}/credentials/${credId}/documents/${fileId}/download-url`, tA, {});
  check("D17. Si la cuidadora vuelve a la agencia A, recupera el acceso con su revisión intacta; la descarga vuelve a auditarse",
    react.status === 200 && listBack.body.credentials?.length === 1 && listBack.body.credentials?.[0]?.organization_review_status === "approved"
    && dlBack.status === 200 && await events(`organization_id=$1`, [A]) === 3, [react.status, listBack.body, dlBack.status]);
  void memB;

  check("D18. Nunca un 500 en todo el recorrido (salvo el fallo simulado de D14)", errors500.length === 0, errors500);

  // ---- 8. Reversión y reaplicación -------------------------------------------------------------------------------------
  server.close(); await pool.end();
  const { readFileSync } = await import("node:fs");
  const kept = await events();
  await q(readFileSync(join(process.cwd(), "ops/162_former_agency_document_access_download_audit.rollback.sql"), "utf8"));
  const rbPolicies = (await q(`SELECT tablename FROM pg_policies WHERE policyname LIKE '%_manager_read_any_status' ORDER BY 1`)).rows.map((r) => r.tablename);
  const rbFn = Number((await q(`SELECT count(*) n FROM pg_proc WHERE proname='app_issue_credential_document_download'`)).rows[0].n);
  check("D19. Reversión: vuelven las 4 políticas de la 137, se retira la función y el registro de descargas se conserva íntegro (retención)",
    JSON.stringify(rbPolicies) === '["credentials","document_versions","documents","workers"]' && rbFn === 0 && await events() === kept, [rbPolicies, rbFn]);
  const mig = readFileSync(join(process.cwd(), "migrations/162_former_agency_document_access_download_audit.sql"), "utf8");
  await q(mig); await q(mig);
  const rePolicies = (await q(`SELECT tablename FROM pg_policies WHERE policyname LIKE '%_manager_read_any_status'`)).rows.map((r) => r.tablename);
  const reFn = Number((await q(`SELECT count(*) n FROM pg_proc WHERE proname='app_issue_credential_document_download'`)).rows[0].n);
  check("D20. Reaplicar la 162 (dos veces) deja el mismo estado, sin tocar los eventos (idempotente)",
    JSON.stringify(rePolicies) === '["workers"]' && reFn === 1 && await events() === kept, [rePolicies, reFn]);

  await rt.end(); await db.end(); moto?.kill();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1200)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  moto?.kill();
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); moto?.kill(); process.exit(1); });

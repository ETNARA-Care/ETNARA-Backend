/**
 * D4 — fechas de documentos institucionales (5-nov-2026). Datos ficticios, base desechable.
 *
 * App real por HTTP como app_runtime (RLS + 149), bucket S3 privado LOCAL (moto, nunca un servicio
 * alojado). Comprueba: carga con fechas, sin vencimiento informado, «sin vencimiento aplicable»,
 * validación, corrección de fechas sin volver a cargar (mismo contenido, original intacto),
 * historial y decisiones anteriores intactos, auditoría, aislamiento entre agencias, permisos por
 * rol, compatibilidad con filas existentes y concurrencia.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

async function main() {
  const s3Port = Number(process.env.DOC_TEST_S3_PORT ?? 4569);
  const moto: ChildProcess = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  let up = false;
  for (let i = 0; i < 360; i++) { try { await fetch(endpoint); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  if (!up) { moto.kill(); throw new Error("Local S3 (moto) did not start"); }
  const bucket = `etnara-docs-test-${randomBytes(4).toString("hex")}`;
  const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, { STORAGE_ENDPOINT: endpoint, STORAGE_REGION: "us-east-1", STORAGE_BUCKET: bucket, STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true" });
  const objectBytes = async (key: string) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());
  const objectCount = async () => ((await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "establishment-documents/" }))).Contents ?? []).length;

  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();

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
    let json: Json = {};
    try { json = await res.json(); } catch { /* 204 */ }
    return { status: res.status, body: json };
  }

  // ---------------------------------------------------------------- fixtures (todo ficticio)
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'RESIDENTIAL_CARE_HOME','active') RETURNING id`, [name])).rows[0].id;
  const orgA = await org(`D4 Hogar A ${tag}`), orgB = await org(`D4 Hogar B ${tag}`);
  const place = async (o: string, n: string) => (await q<{ id: string }>(`INSERT INTO locations (organization_id,name) VALUES ($1,$2) RETURNING id`, [o, n])).rows[0].id;
  const eA = await place(orgA, `Sede A1 ${tag}`), eA2 = await place(orgA, `Sede A2 ${tag}`), eB = await place(orgB, `Sede B ${tag}`);
  type P = { email: string; userId: string; token: string; membership: string; orgId: string };
  async function person(key: string, orgId: string, roles: string[]): Promise<P> {
    const email = `d4-${key}-${tag}@example.invalid`;
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const membership = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [userId, orgId])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [membership, orgId, roles]);
    return { email, userId, token: "", membership, orgId };
  }
  const A = {
    admin: await person("a-admin", orgA, ["ORGANIZATION_ADMIN"]), sup: await person("a-sup", orgA, ["SUPERVISOR"]),
    estAdmin: await person("a-estadmin", orgA, ["WORKER"]), estAdmin2: await person("a-estadmin2", orgA, ["WORKER"]),
    worker: await person("a-worker", orgA, ["WORKER"]), family: await person("a-family", orgA, ["FAMILY"]),
  };
  const B = { admin: await person("b-admin", orgB, ["ORGANIZATION_ADMIN"]) };
  await q(`INSERT INTO establishment_admin_assignments (organization_id,location_id,organization_membership_id) VALUES ($1,$2,$3),($1,$4,$5)`, [orgA, eA, A.estAdmin.membership, eA2, A.estAdmin2.membership]);
  // Central: superadministradora de plataforma sin membresía en la agencia.
  const central = await person("central", orgB, []);
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [central.membership]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.userId]);
  for (const p of [...Object.values(A), ...Object.values(B), central]) {
    const r = await call("POST", "/auth/login", "", { email: p.email, password });
    if (r.status !== 200) throw new Error(`login ${p.email} ${r.status}`);
    p.token = r.body.token;
    if (p !== central) await call("POST", "/me/active-organization", p.token, { organizationId: p.orgId });
  }
  const docs = (o: string, e: string) => `/organizations/${o}/establishments/${e}/documents`;
  const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% documento ficticio ${label} ${tag}\n%%EOF\n`);
  const upload = (who: P, type: string, opts: { issuedOn?: string; expiresOn?: string } = {}, o = orgA, e = eA, body = pdf(type)) => {
    const qs = new URLSearchParams({ documentType: type, title: type, fileName: `${type.replace(/\s/g, "-")}.pdf` });
    if (opts.issuedOn !== undefined) qs.set("issuedOn", opts.issuedOn);
    if (opts.expiresOn !== undefined) qs.set("expiresOn", opts.expiresOn);
    return call("POST", `${docs(o, e)}?${qs}`, who.token, body);
  };
  const row = async (id: string) => (await q(`SELECT * FROM establishment_documents WHERE id=$1`, [id])).rows[0];
  const ymd = (v: unknown) => (v == null ? null : String(v).slice(0, 10));

  // ---------------------------------------------------------------- 1. carga con fechas
  const lic = await upload(A.admin, "Licencia sanitaria", { issuedOn: "2026-01-15", expiresOn: "2027-01-15" });
  check("1. Carga con fechas: 201, fechas guardadas, expiry_status=date", lic.status === 201 && lic.body.document.issued_on === "2026-01-15" && lic.body.document.expires_on === "2027-01-15" && lic.body.document.expiry_status === "date" && lic.body.document.expiry_not_applicable === false, lic.status);

  // ---------------------------------------------------------------- 2. sin vencimiento informado
  const noDate = await upload(A.admin, "Póliza de responsabilidad");
  check("2. Carga sin vencimiento informado: expires_on null, expiry_status=not_informed", noDate.status === 201 && noDate.body.document.expires_on === null && noDate.body.document.expiry_status === "not_informed", noDate.body.document?.expiry_status);

  // ---------------------------------------------------------------- 3. sin vencimiento aplicable
  const none = await upload(A.admin, "Menú certificado", { issuedOn: "2025-06-01", expiresOn: "none" });
  const noneRow = await row(none.body.document.id);
  check("3. «Sin vencimiento aplicable»: marca explícita, sin fecha artificial (expires_on NULL, expiry_status=not_applicable)", none.status === 201 && none.body.document.expires_on === null && none.body.document.expiry_not_applicable === true && none.body.document.expiry_status === "not_applicable" && noneRow.expires_on === null && noneRow.expiry_not_applicable === true, none.body.document?.expiry_status);
  const forbidden = await q(`UPDATE establishment_documents SET expires_on='2030-01-01' WHERE id=$1`, [none.body.document.id]).then(() => "updated", (e) => (e as { code?: string }).code ?? "error");
  check("150: la base rechaza «no aplica» con fecha a la vez (restricción, 23514)", forbidden === "23514", forbidden);

  // Validación en la carga: nada se guarda ni se sube
  const before = await objectCount();
  const bad = [
    await upload(A.admin, "Certificación de Bomberos", { expiresOn: "2027-02-30" }),
    await upload(A.admin, "Certificación de Bomberos", { issuedOn: "15/01/2026" }),
    await upload(A.admin, "Certificación de Bomberos", { issuedOn: "2026-05-01", expiresOn: "2026-04-30" }),
    await upload(A.admin, "Certificación de Bomberos", { issuedOn: "2099-01-01" }),
  ];
  check("Validación en la carga: fecha imposible, formato, cronología y emisión futura → 400", bad.every((r) => r.status === 400 && r.body.error === "INVALID_DOCUMENT_DATES"), bad.map((r) => `${r.status}:${r.body.field}:${r.body.reason}`));
  check("Validación en la carga: no sube archivo ni crea fila", (await objectCount()) === before && Number((await q(`SELECT count(*) FROM establishment_documents WHERE organization_id=$1 AND document_type='Certificación de Bomberos'`, [orgA])).rows[0].count) === 0);

  // ---------------------------------------------------------------- 9. compatibilidad: documento antiguo (sin fechas, decisión histórica de Central)
  const legacyKey = `establishment-documents/${orgA}/${eA}/${randomUUID()}/licencia-antigua.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: legacyKey, Body: pdf("antiguo"), ContentType: "application/pdf" }));
  const legacyId = (await q<{ id: string }>(`INSERT INTO establishment_documents (organization_id,establishment_id,document_type,title,file_name,content_type,size_bytes,storage_key,uploaded_by_user_id,review_status,reviewed_by_user_id,reviewed_at,review_reason,created_at)
     VALUES ($1,$2,'Licencia del Departamento de la Familia','Licencia del Departamento de la Familia','licencia-antigua.pdf','application/pdf',$3,$4,$5,'approved',$6,now()-interval '20 days',null,now()-interval '30 days') RETURNING id`, [orgA, eA, pdf("antiguo").byteLength, legacyKey, A.admin.userId, central.userId])).rows[0].id;
  const listed = await call("GET", docs(orgA, eA), A.admin.token);
  const legacyListed = (listed.body.documents ?? []).find((d: Json) => d.id === legacyId);
  check("9. Documento existente sin fechas sigue listado igual (expires_on null → «no informado», decisión histórica visible)", listed.status === 200 && legacyListed?.expires_on === null && legacyListed?.expiry_status === "not_informed" && legacyListed?.review_status === "approved");

  // ---------------------------------------------------------------- 4. corrección de fechas sin volver a cargar
  const objectsBefore = await objectCount();
  const fix = await call("POST", `${docs(orgA, eA)}/${legacyId}/dates`, A.admin.token, { issuedOn: "2025-03-10", expiresOn: "2026-11-20" });
  const newId = fix.body.document?.id;
  check("4. Corrección: 201, versión nueva con las fechas corregidas", fix.status === 201 && fix.body.changed === true && newId && newId !== legacyId && fix.body.document.issued_on === "2025-03-10" && fix.body.document.expires_on === "2026-11-20", fix.status);
  const oldRow = await row(legacyId), newRow = await row(newId);
  check("4. Mismo archivo: nombre, tipo y tamaño iguales; contenido idéntico (copia en el servidor)", newRow.file_name === oldRow.file_name && newRow.content_type === oldRow.content_type && String(newRow.size_bytes) === String(oldRow.size_bytes) && (await objectBytes(newRow.storage_key)).equals(await objectBytes(oldRow.storage_key)));
  check("4. El objeto original sigue en el bucket y sin cambios", (await objectBytes(legacyKey)).equals(pdf("antiguo")));
  check("4. Exactamente un objeto nuevo (ninguna carga del usuario)", (await objectCount()) === objectsBefore + 1, `${objectsBefore}→${await objectCount()}`);
  const dl = await call("GET", `${docs(orgA, eA)}/${newId}/download`, A.admin.token);
  const dlBytes = dl.status === 200 ? Buffer.from(await (await fetch(dl.body.url)).arrayBuffer()) : Buffer.alloc(0);
  check("4. La agencia descarga la versión corregida y obtiene el mismo archivo", dl.status === 200 && dlBytes.equals(pdf("antiguo")));

  // ---------------------------------------------------------------- 5. historial
  check("5. Versión anterior archivada con sus fechas y su decisión histórica intactas", oldRow.archived_at !== null && oldRow.issued_on === null && oldRow.expires_on === null && oldRow.review_status === "approved" && oldRow.reviewed_by_user_id === central.userId);
  check("5. La versión nueva no hereda ninguna decisión (sin aprobación de Central)", newRow.review_status === "pending" && newRow.reviewed_by_user_id === null && newRow.uploaded_by_user_id === A.admin.userId);
  const hist = await call("GET", `${docs(orgA, eA)}-history?documentType=${encodeURIComponent("Licencia del Departamento de la Familia")}`, A.admin.token);
  const h = hist.body.documents ?? [];
  check("5. Historial: 2 versiones, la nueva actual y marcada «fechas corregidas», la anterior no", hist.status === 200 && h.length === 2 && h[0].id === newId && h[0].is_current && h[0].dates_corrected === true && h[1].id === legacyId && !h[1].is_current && h[1].dates_corrected === false, h.map((d: Json) => [d.is_current, d.dates_corrected]));
  const audit = (await q(`SELECT actor_user_id,organization_id,previous_value,new_value,occurred_at FROM audit_log WHERE action='ESTABLISHMENT_DOCUMENT_DATES_CORRECTED' AND entity_id=$1`, [newId])).rows;
  check("5. Auditoría: quién, cuándo y qué cambió (antes/después), sin claves de archivo", audit.length === 1 && audit[0].actor_user_id === A.admin.userId && audit[0].organization_id === orgA && audit[0].previous_value.document_id === legacyId && audit[0].previous_value.expires_on === null && audit[0].new_value.expires_on === "2026-11-20" && audit[0].occurred_at && !JSON.stringify(audit[0]).includes("establishment-documents/"));

  // Sin cambios → 200 y nada nuevo; corregir una versión archivada → 409; borrar fecha → no informado
  const n0 = await objectCount();
  const same = await call("POST", `${docs(orgA, eA)}/${newId}/dates`, A.admin.token, { issuedOn: "2025-03-10", expiresOn: "2026-11-20" });
  check("Sin cambios: 200 changed=false, sin versión ni objeto nuevo", same.status === 200 && same.body.changed === false && (await objectCount()) === n0);
  const archived = await call("POST", `${docs(orgA, eA)}/${legacyId}/dates`, A.admin.token, { expiresOn: "2027-01-01" });
  check("Versión archivada no se corrige: 409", archived.status === 409 && archived.body.error === "ESTABLISHMENT_DOCUMENT_NOT_CURRENT", archived.status);
  const incoherent = await call("POST", `${docs(orgA, eA)}/${newId}/dates`, A.admin.token, { expiresOn: "2025-01-01" });
  check("Corrección incoherente (vence antes de emitirse): 400", incoherent.status === 400 && incoherent.body.reason === "EXPIRES_BEFORE_ISSUED");
  const badBody = await call("POST", `${docs(orgA, eA)}/${newId}/dates`, A.admin.token, { expiresOn: "2027-01-01", storageKey: "x" });
  check("Cuerpo con campos extra: 400", badBody.status === 400);
  const partial = await call("POST", `${docs(orgA, eA)}/${noDate.body.document.id}/dates`, A.sup.token, { expiresOn: "none" });
  check("Corrección parcial (solo vencimiento → «no aplica») conserva la emisión", partial.status === 201 && partial.body.document.expires_on === null && partial.body.document.expiry_status === "not_applicable" && partial.body.document.issued_on === null);
  const back = await call("POST", `${docs(orgA, eA)}/${partial.body.document.id}/dates`, A.admin.token, { expiresOn: "2027-06-30" });
  const histNa = (await call("GET", `${docs(orgA, eA)}-history?documentType=${encodeURIComponent("Póliza de responsabilidad")}`, A.admin.token)).body.documents ?? [];
  check("«No aplica» → fecha real: la marca se quita en la versión nueva y el historial conserva los 3 estados", back.status === 201 && back.body.document.expiry_status === "date" && histNa.map((d: Json) => d.expiry_status).join() === "date,not_applicable,not_informed", histNa.map((d: Json) => d.expiry_status));
  const aud = (await q(`SELECT previous_value,new_value FROM audit_log WHERE action='ESTABLISHMENT_DOCUMENT_DATES_CORRECTED' AND entity_id=$1`, [back.body.document.id])).rows[0];
  check("Auditoría registra la marca antes/después", aud?.previous_value.expiry_not_applicable === true && aud?.new_value.expiry_not_applicable === false);

  // ---------------------------------------------------------------- 7. permisos por rol
  const curLic = lic.body.document.id;
  const tryRole = async (p: P, e = eA, id = curLic) => (await call("POST", `${docs(orgA, e)}/${id}/dates`, p.token, { issuedOn: "2026-01-16" })).status;
  const supStatus = await tryRole(A.sup);
  const licNow = (await q<{ id: string }>(`SELECT id FROM establishment_documents WHERE organization_id=$1 AND establishment_id=$2 AND document_type='Licencia sanitaria' AND archived_at IS NULL`, [orgA, eA])).rows[0].id;
  const estAdminStatus = (await call("POST", `${docs(orgA, eA)}/${licNow}/dates`, A.estAdmin.token, { issuedOn: "2026-01-17" })).status;
  const licNow2 = (await q<{ id: string }>(`SELECT id FROM establishment_documents WHERE organization_id=$1 AND establishment_id=$2 AND document_type='Licencia sanitaria' AND archived_at IS NULL`, [orgA, eA])).rows[0].id;
  const other = await tryRole(A.estAdmin2, eA, licNow2), worker = await tryRole(A.worker, eA, licNow2), family = await tryRole(A.family, eA, licNow2);
  check("7. Supervisora (gestión) corrige: 201", supStatus === 201, supStatus);
  check("7. Administradora de ESE establecimiento corrige: 201", estAdminStatus === 201, estAdminStatus);
  check("7. Administradora de OTRO establecimiento: 403", other === 403, other);
  check("7. Cuidadora: 403 · Familia: 403", worker === 403 && family === 403, [worker, family]);
  const workerUpload = await upload(A.worker, "Certificación de Bomberos", { expiresOn: "2027-01-01" });
  check("7. Cuidadora tampoco carga documentos: 403", workerUpload.status === 403, workerUpload.status);

  // ---------------------------------------------------------------- 6. aislamiento entre agencias y Central
  const bDoc = await upload(B.admin, "Licencia sanitaria", { expiresOn: "2027-03-01" }, orgB, eB);
  const crossA = await call("POST", `${docs(orgA, eA)}/${bDoc.body.document.id}/dates`, A.admin.token, { expiresOn: "2030-01-01" });
  const crossPath = await call("POST", `${docs(orgB, eB)}/${bDoc.body.document.id}/dates`, A.admin.token, { expiresOn: "2030-01-01" });
  const crossB = await call("POST", `${docs(orgA, eA)}/${licNow2}/dates`, B.admin.token, { expiresOn: "2030-01-01" });
  const crossEst = await call("POST", `${docs(orgA, eB)}/${bDoc.body.document.id}/dates`, A.admin.token, { expiresOn: "2030-01-01" });
  check("6. Agencia A no corrige documentos de B (por su ruta ni por la de B)", [crossA.status, crossPath.status, crossEst.status].every((s) => s === 403 || s === 404), [crossA.status, crossPath.status, crossEst.status]);
  check("6. Agencia B no corrige documentos de A", [403, 404].includes(crossB.status), crossB.status);
  check("6. El documento de B no cambió", ymd((await row(bDoc.body.document.id)).expires_on) === "2027-03-01" && (await row(bDoc.body.document.id)).archived_at === null);
  const centralTry = await call("POST", `${docs(orgA, eA)}/${licNow2}/dates`, central.token, { expiresOn: "2030-01-01" });
  const centralList = await call("GET", docs(orgA, eA), central.token);
  check("6. ETNARA Central no corrige ni lista documentos de la agencia", centralTry.status === 403 && centralList.status === 403, [centralTry.status, centralList.status]);
  const ownVersions = Number((await q(`SELECT count(*) FROM establishment_documents WHERE organization_id=$1`, [orgB])).rows[0].count);
  check("6. Ninguna versión nueva en B por intentos ajenos", ownVersions === 1, ownVersions);

  // ---------------------------------------------------------------- concurrencia
  const target = (await q<{ id: string }>(`SELECT id FROM establishment_documents WHERE organization_id=$1 AND establishment_id=$2 AND document_type='Menú certificado' AND archived_at IS NULL`, [orgA, eA])).rows[0].id;
  const [c1, c2] = await Promise.all([
    call("POST", `${docs(orgA, eA)}/${target}/dates`, A.admin.token, { expiresOn: "2028-01-01" }),
    call("POST", `${docs(orgA, eA)}/${target}/dates`, A.sup.token, { expiresOn: "2029-01-01" }),
  ]);
  const current = Number((await q(`SELECT count(*) FROM establishment_documents WHERE organization_id=$1 AND establishment_id=$2 AND document_type='Menú certificado' AND archived_at IS NULL`, [orgA, eA])).rows[0].count);
  check("Concurrencia: una corrección gana (201), la otra recibe 409; una sola versión actual", [c1.status, c2.status].sort().join() === "201,409" && current === 1, [c1.status, c2.status, current]);

  // ---------------------------------------------------------------- 149 intacta
  const hacked = await (async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    try { await c.query(`UPDATE establishment_documents SET expires_on='2099-01-01' WHERE id=$1`, [licNow2]); return "updated"; } catch (e) { return (e as { code?: string }).code ?? "error"; } finally { await c.end(); }
  })();
  check("149 intacta: app_runtime sigue sin poder modificar fechas en sitio (42501)", hacked === "42501", hacked);

  console.log("| Comprobación | Resultado | Detalle |\n|---|---|---|");
  for (const r of results) console.log(`| ${r.check} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.slice(0, 120)} |`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  server.close(); await pool.end(); await db.end(); moto.kill();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

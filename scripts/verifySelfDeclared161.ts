/**
 * 161 · Cuidador independiente, PR C: documentos autodeclarados, elegibilidad propia, confirmación auditada e
 * «Informe del proveedor». Datos FICTICIOS, base PROPIA desechable, correo interceptado, app real por HTTP (app_runtime).
 * Incluye: aislamiento entre organizaciones, conflictos de horario, permisos, acceso familiar, una persona que también
 * trabaja para una agencia (sin herencia) y la no regresión de agencias y hogares.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
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

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, html: String(b.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";

let moto: ChildProcess | null = null;
async function main() {
  // S3 LOCAL (moto) para el almacenamiento seguro de documentos que ya usa ETNARA Care: nunca un servicio alojado.
  const s3Port = Number(process.env.S161_TEST_S3_PORT ?? 4581);
  moto = spawn(process.env.PHOTO_TEST_PYTHON ?? "python3", ["-m", "moto.server", "-H", "127.0.0.1", "-p", String(s3Port)], { stdio: "ignore" });
  const endpoint = `http://127.0.0.1:${s3Port}`;
  for (let i = 0; i < 50; i++) { try { await realFetch(endpoint); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const bucket = `s161-${randomUUID().slice(0, 8)}`;
  await new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } }).send(new CreateBucketCommand({ Bucket: bucket }));
  Object.assign(process.env, { STORAGE_ENDPOINT: endpoint, STORAGE_REGION: "us-east-1", STORAGE_BUCKET: bucket, STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true" });
  const own = `etnara_s161_${randomBytes(4).toString("hex")}`;
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
  // Como la aplicación en una petición (mismos ajustes que withTenantContext): devuelve "OK" o el mensaje del error.
  const asApp = async (userId: string, orgId: string, stmt: string, params: unknown[] = []) => {
    try {
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [userId, orgId]);
      await rt.query(stmt, params); await rt.query("ROLLBACK"); return "OK";
    } catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as Error).message; }
  };

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
  async function call(method: string, path: string, token: string, body?: Json | Buffer) {
    const isBuf = Buffer.isBuffer(body);
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": isBuf ? "application/pdf" : "application/json" } : {}) },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
    const text = await res.text(); let json: Json = {}; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 40) }; }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json, type: res.headers.get("content-type") ?? "" };
  }
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `s161-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const tokenFor = (email: string) => { const m = [...mails].reverse().find((x) => x.to === email); return /token=([a-f0-9]{64})/i.exec(m?.html ?? "")?.[1] ?? ""; };
  const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const feature = async (o: string, code: string) => q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,$2,true) ON CONFLICT (organization_id, feature_code) DO UPDATE SET enabled=true`, [o, code]);
  const types = (await q<{ code: string }>(`SELECT code FROM credential_types ORDER BY code LIMIT 2`)).rows.map((r) => r.code);
  const [T1, T2] = types;

  // ---- Base ficticia ------------------------------------------------------------------------------------------
  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY"), H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME");
  const adminA = await user("admin-agencia"); const adminAMem = await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminH = await user("admin-hogar"); await member(adminH, H, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tC = await login(central), tA = await login(adminA, A), tH = await login(adminH, H);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const mkIndependent = async (name: string, email: string, existing?: { email: string }) => {
    const o = (await call("POST", "/platform/organizations", tC, { name, organizationType: "INDEPENDENT_PROVIDER" })).body.organization.id as string;
    await call("POST", `/platform/organizations/${o}/admin-invitations`, tC, { email });
    if (existing) await call("POST", "/platform/admin-invitations/accept", await login(existing), { token: tokenFor(email) });
    else await call("POST", "/platform/admin-invitations/activate", "", { token: tokenFor(email), password });
    await feature(o, "SHIFT_REPORTS");
    return o;
  };
  const luciaEmail = `s161-lucia-${tag}@example.invalid`;
  const L = await mkIndependent(`Práctica Lucía ${tag}`, luciaEmail);
  const lucia = { email: luciaEmail, id: (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [luciaEmail])).rows[0].id };
  const tL = await login(lucia, L);
  const lMem = (await q<{ id: string; worker_id: string }>(`SELECT id, worker_id FROM organization_worker_memberships WHERE organization_id=$1`, [L])).rows[0];
  // Ana: CNA en la agencia A (con una credencial registrada por la agencia) y además independiente.
  const ana = await user("ana");
  const anaWorker = (await q<{ id: string }>(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [ana.id])).rows[0].id;
  await member(ana, A, ["WORKER"]);
  const anaMemA = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [anaWorker, A])).rows[0].id;
  const N = await mkIndependent(`Práctica Ana ${tag}`, ana.email, ana);
  const tAnaN = await login(ana, N), tAnaA = await login(ana, A);
  const nMem = (await q<{ id: string }>(`SELECT id FROM organization_worker_memberships WHERE organization_id=$1`, [N])).rows[0].id;

  const client = (await call("POST", `/organizations/${L}/care-recipients`, tL, { firstName: "Carmen", lastName: "Ficticia" })).body;
  const clientId = (client.careRecipient ?? client.recipient ?? client).id as string;
  const newShift = async (token: string, o: string, recipient: string, startMin: number, endMin: number) => {
    const r = await call("POST", `/organizations/${o}/shifts`, token, { careRecipientId: recipient, scheduledStart: iso(startMin), scheduledEnd: iso(endMin), requiredRole: "INDEPENDENT_CAREGIVER" });
    return (r.body.shift ?? r.body).id as string;
  };

  // ---- 1. Documentos autodeclarados y estados por fechas --------------------------------------------------------
  const d0 = await call("GET", `/organizations/${L}/practice/documents`, tL);
  const s0 = await newShift(tL, L, clientId, 300, 420);
  const sa0 = await call("POST", `/organizations/${L}/me/shifts/${s0}/self-assign`, tL, {});
  check("C1. Sin política propia: «Mis documentos» con el aviso (autodeclarados, sin verificación de ETNARA) y se asigna sin confirmación",
    d0.status === 200 && d0.body.policyConfigured === false && /ETNARA Care no verifica, aprueba ni certifica/.test(d0.body.notice) && sa0.status === 201, [d0.status, d0.body.notice, sa0.status, sa0.body.error]);
  const pol = await call("PUT", `/organizations/${L}/practice/requirements`, tL, { credentialTypeCodes: [T1, T2] });
  const polRows = await q<{ r: boolean }>(`SELECT r.requires_organization_review r FROM requirements r JOIN requirement_sets s ON s.id=r.requirement_set_id WHERE s.organization_id=$1`, [L]);
  const polReview = await call("PUT", `/organizations/${L}/compliance/configuration`, tL, { workerRole: "INDEPENDENT_CAREGIVER", requirements: [{ credentialTypeCode: T1, isMandatory: true, requiresOrganizationReview: true }] });
  check("C2. Define SUS requisitos (opcionales); nunca con «revisión de la organización», ni por la ruta general (409)",
    pol.status === 200 && polRows.rows.length === 2 && polRows.rows.every((r) => r.r === false) && polReview.status === 409 && polReview.body.error === "INDEPENDENT_REQUIREMENT_NO_REVIEW", [pol.status, polRows.rows, polReview.status, polReview.body]);
  const d1 = await call("GET", `/organizations/${L}/practice/documents`, tL);
  check("C3. Con requisitos y nada registrado: estado «Falta» en ambos", d1.body.requirements?.every((r: Json) => r.status === "MISSING") && d1.body.pendingMandatory?.length === 2, d1.body.requirements);

  // ---- 2. Confirmación expresa y auditada --------------------------------------------------------------------------
  const s1 = await newShift(tL, L, clientId, 24 * 60, 24 * 60 + 120);
  const need = await call("POST", `/organizations/${L}/me/shifts/${s1}/self-assign`, tL, {});
  const left1 = await q(`SELECT 1 FROM assignments WHERE shift_id=$1`, [s1]);
  check("C4. Con faltantes: advertencia (409 SELF_DECLARATION_CONFIRMATION_REQUIRED) con lo que falta y el texto fijo; no se asigna nada",
    need.status === 409 && need.body.error === "SELF_DECLARATION_CONFIRMATION_REQUIRED" && need.body.missing?.length === 2
    && need.body.notice === "ETNARA Care no verifica ni certifica documentos. Esta confirmación no sustituye los requisitos legales que te correspondan." && left1.rowCount === 0,
    [need.status, need.body]);
  const ok1 = await call("POST", `/organizations/${L}/me/shifts/${s1}/self-assign`, tL, { confirmSelfDeclaration: true });
  const aud1 = await q<{ v: Json; actor: string }>(`SELECT new_value v, actor_user_id actor FROM audit_log WHERE action='SELF_DECLARATION_CONFIRMED' AND organization_id=$1`, [L]);
  check("C5. Con su confirmación expresa: se asigna y queda auditada (quién, turno, qué faltaba, la frase confirmada y el aviso legal)",
    ok1.status === 201 && ok1.body.assignment?.response_status === "accepted" && aud1.rowCount === 1 && aud1.rows[0].actor === lucia.id
    && aud1.rows[0].v.missing?.length === 2 && aud1.rows[0].v.shiftId === s1 && /no sustituye los requisitos legales/.test(aud1.rows[0].v.notice), [ok1.status, ok1.body.error, aud1.rows]);
  const bad = await call("POST", `/organizations/${L}/me/shifts/${s1}/self-assign`, tL, { confirmSelfDeclaration: "sí" });
  check("C6. La confirmación solo vale si es expresa (true); cualquier otro valor se rechaza (400)", bad.status === 400, bad);

  // Registrar, vencer, renovar y retirar
  const r1 = await call("POST", `/organizations/${L}/practice/documents`, tL, { credentialTypeCode: T1, issuingEntityName: "Entidad ficticia", issuedAt: day(-300), expiresAt: day(10) });
  const r2 = await call("POST", `/organizations/${L}/practice/documents`, tL, { credentialTypeCode: T2, expiresAt: day(-5) });
  const d2 = await call("GET", `/organizations/${L}/practice/documents`, tL);
  const st = Object.fromEntries((d2.body.requirements ?? []).map((r: Json) => [r.credentialTypeCode, r.status]));
  check("C7. Estados solo por lo registrado: «Vence pronto» (10 días) y «Vencido»; los documentos quedan como autodeclarados",
    r1.status === 201 && r2.status === 201 && st[T1] === "EXPIRING_SOON" && st[T2] === "EXPIRED" && d2.body.documents.every((d: Json) => d.selfDeclared === true), [r1.status, r2.status, st]);
  const renew = await call("POST", `/organizations/${L}/practice/documents`, tL, { credentialTypeCode: T2, issuedAt: day(-1), expiresAt: day(365) });
  const fix = await call("PATCH", `/organizations/${L}/practice/documents/${r1.body.id}`, tL, { expiresAt: day(200) });
  const d3 = await call("GET", `/organizations/${L}/practice/documents`, tL);
  const st3 = Object.fromEntries((d3.body.requirements ?? []).map((r: Json) => [r.credentialTypeCode, r.status]));
  check("C8. Renovar (nuevo registro vigente; el anterior queda en el historial) y corregir: ambos «Registrado»",
    renew.status === 201 && fix.status === 200 && st3[T1] === "REGISTERED" && st3[T2] === "REGISTERED" && d3.body.documents.filter((d: Json) => d.credentialTypeCode === T2).length === 2, [renew.status, fix.status, st3]);
  const allStates = JSON.stringify([d0.body, d1.body, d2.body, d3.body]);
  check("C9. Nunca «Verificado», «Aprobado» ni «Certificado» en los estados de sus documentos", !/VERIFIED|APPROVED|CERTIFIED|Verificad|Aprobad|Certificad/.test(allStates.replace(/no verifica, aprueba ni certifica/g, "")));
  const s2 = await newShift(tL, L, clientId, 48 * 60, 48 * 60 + 60);
  const ok2 = await call("POST", `/organizations/${L}/me/shifts/${s2}/self-assign`, tL, {});
  check("C10. Con todo registrado y vigente: se asigna sin confirmación", ok2.status === 201, [ok2.status, ok2.body]);
  const retire = await call("PATCH", `/organizations/${L}/practice/documents/${renew.body.id}`, tL, { retire: true });
  const d4 = await call("GET", `/organizations/${L}/practice/documents`, tL);
  const audDocs = await q<{ action: string }>(`SELECT action FROM audit_log WHERE organization_id=$1 AND action LIKE 'SELF_DECLARED_DOCUMENT_%'`, [L]);
  check("C11. Retirar no borra: queda «Retirado» en el historial y vuelve a contar el registro anterior (vencido); todo auditado",
    retire.status === 200 && d4.body.documents.some((d: Json) => d.id === renew.body.id && d.status === "RETIRED")
    && d4.body.requirements.find((r: Json) => r.credentialTypeCode === T2)?.status === "EXPIRED"
    && audDocs.rows.filter((r) => r.action === "SELF_DECLARED_DOCUMENT_REGISTERED").length === 3 && audDocs.rows.some((r) => r.action === "SELF_DECLARED_DOCUMENT_RETIRED"), [retire.status, audDocs.rows.length]);

  // ---- 3. Permisos en la base de datos (aunque se salte el backend) ---------------------------------------------
  const typeId = (await q<{ id: string }>(`SELECT id FROM credential_types WHERE code=$1`, [T1])).rows[0].id;
  const insDeclared = (worker: string) => `INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status, declared_by_holder) VALUES ('${worker}','${typeId}','external_provider','active',true)`;
  const p1 = await asApp(adminA.id, A, insDeclared(lMem.worker_id));
  const p2 = await asApp(ana.id, A, insDeclared(anaWorker));
  const p3 = await asApp(lucia.id, L, `INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status) VALUES ('${lMem.worker_id}','${typeId}','external_provider','active')`);
  const p4 = await asApp(lucia.id, L, `UPDATE credentials SET declared_by_holder=false WHERE id='${r1.body.id}'`);
  const p5 = await asApp(lucia.id, L, `DELETE FROM credentials WHERE id='${r1.body.id}'`);
  check("C12. Base de datos: nadie más crea un autodeclarado; su titular solo dentro de SU práctica independiente; sin autodeclarar no gestiona los suyos (regla de siempre); el origen no cambia; no se borra",
    p1.includes("CREDENTIAL_SELF_DECLARATION_FORBIDDEN") && p2.includes("CREDENTIAL_SELF_DECLARATION_FORBIDDEN") && p3.includes("CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN")
    && p4.includes("CREDENTIAL_ORIGIN_IMMUTABLE") && p5.includes("CREDENTIAL_SELF_DECLARED_NOT_DELETABLE"), [p1, p2, p3, p4, p5]);
  const wrongOrg = await call("GET", `/organizations/${A}/practice/documents`, tAnaA);
  const notMine = await call("GET", `/organizations/${L}/practice/documents`, tA);
  const otherPatch = await call("PATCH", `/organizations/${N}/practice/documents/${r1.body.id}`, tAnaN, { expiresAt: day(30) });
  check("C13. Permisos: «Mis documentos» solo en su propia práctica; ni la agencia ni otra independiente ven o tocan documentos ajenos",
    wrongOrg.status === 403 && notMine.status === 403 && otherPatch.status === 404, [wrongOrg.status, notMine.status, otherPatch.status]);

  // ---- 4. Persona que también trabaja para una agencia: la agencia no hereda nada ----------------------------------
  const setA = (await q<{ id: string }>(`INSERT INTO requirement_sets (organization_id, worker_role, name) VALUES ($1,'CNA','Política ficticia A (sin revisión)') RETURNING id`, [A])).rows[0].id;
  await q(`INSERT INTO requirements (requirement_set_id, credential_type_id, is_mandatory, requires_organization_review) VALUES ($1,$2,true,false)`, [setA, typeId]);
  const anaDecl = await call("POST", `/organizations/${N}/practice/documents`, tAnaN, { credentialTypeCode: T1, expiresAt: day(300) });
  const eligA1 = await call("GET", `/organizations/${A}/workers/${anaMemA}/compliance`, tA);
  const listA = await call("GET", `/organizations/${A}/workers/${anaWorker}/credentials`, tA);
  const editByAgency = await asApp(adminA.id, A, `UPDATE credentials SET expires_at = current_date + 1 WHERE id='${anaDecl.body.id}'`);
  await q(`INSERT INTO organization_credential_reviews (credential_id, organization_id, reviewed_by_user_id, review_status, reviewed_at) VALUES ($1,$2,$3,'approved',now())`, [anaDecl.body.id, A, adminA.id]);
  const eligA2 = await call("GET", `/organizations/${A}/workers/${anaMemA}/compliance`, tA);
  const eligN = await call("GET", `/organizations/${N}/practice/documents`, tAnaN);
  check("C14. Sin herencia: su documento autodeclarado NO la hace elegible en la agencia (aunque el requisito no pida revisión) hasta que ESA agencia lo revisa; la agencia lo ve como «registrado por la cuidadora» y no puede editarlo",
    anaDecl.status === 201 && eligA1.body.eligibility === "not_eligible" && eligA1.body.requirements?.[0]?.status === "ORGANIZATION_REVIEW_MISSING"
    && JSON.stringify(listA.body).includes('"declared_by_holder":true') && editByAgency.includes("CREDENTIAL_SELF_DECLARATION_FORBIDDEN")
    && eligA2.body.eligibility === "eligible" && eligN.status === 200, [anaDecl.status, eligA1.body, listA.status, editByAgency, eligA2.body]);
  const anaReviewSelf = await asApp(ana.id, N, `INSERT INTO organization_credential_reviews (credential_id, organization_id, reviewed_by_user_id, review_status, reviewed_at) VALUES ('${anaDecl.body.id}','${N}','${ana.id}','approved',now())`);
  check("C15. Nadie se aprueba a sí misma, tampoco en su práctica (guarda de autorrevisión intacta)", anaReviewSelf.includes("CREDENTIAL_SELF_REVIEW_FORBIDDEN"), anaReviewSelf);

  // ---- 5. Conflictos de horario entre organizaciones --------------------------------------------------------------
  const recA = (await call("POST", `/organizations/${A}/care-recipients`, tA, { firstName: "Persona", lastName: "Agencia" })).body;
  const recAId = (recA.careRecipient ?? recA.recipient ?? recA).id as string;
  const shA = (await call("POST", `/organizations/${A}/shifts`, tA, { careRecipientId: recAId, scheduledStart: iso(72 * 60), scheduledEnd: iso(72 * 60 + 240), requiredRole: "CNA" })).body;
  const shAId = (shA.shift ?? shA).id as string;
  const asgA = await call("POST", `/organizations/${A}/shifts/${shAId}/assignments`, tA, { organizationWorkerMembershipId: anaMemA });
  const accA = await call("POST", `/organizations/${A}/me/shifts/${shAId}/respond`, tAnaA, { decision: "accepted" });
  await call("PUT", `/organizations/${N}/practice/requirements`, tAnaN, { credentialTypeCodes: [T1, T2] }); // T2 le falta → confirmación
  const recN = (await call("POST", `/organizations/${N}/care-recipients`, tAnaN, { firstName: "Cliente", lastName: "Ana" })).body;
  const recNId = (recN.careRecipient ?? recN.recipient ?? recN).id as string;
  const shN = await newShift(tAnaN, N, recNId, 72 * 60 + 60, 72 * 60 + 180);
  const clash = await call("POST", `/organizations/${N}/me/shifts/${shN}/self-assign`, tAnaN, { confirmSelfDeclaration: true });
  const clashAudit = await q(`SELECT 1 FROM audit_log WHERE action='SELF_DECLARATION_CONFIRMED' AND organization_id=$1`, [N]);
  const clashLeft = await q(`SELECT 1 FROM assignments WHERE shift_id=$1`, [shN]);
  check("C16. Horarios: aun confirmando, no se asigna un turno que choca con el aceptado en la agencia; nada queda a medias ni en la auditoría",
    asgA.status === 201 && accA.status === 200 && clash.status === 409 && clash.body.error === "MY_SCHEDULE_CONFLICT" && clashAudit.rowCount === 0 && clashLeft.rowCount === 0,
    [asgA.status, accA.status, clash.status, clash.body.error, clashAudit.rowCount]);

  // ---- 6. «Informe del proveedor» y acceso familiar -----------------------------------------------------------------
  const fam = await call("POST", `/organizations/${L}/access-invitations`, tL, { type: "family", email: `s161-familia-${tag}@example.invalid`, careRecipientId: clientId, relationshipType: "hija" });
  const famAct = await call("POST", "/access-invitations/activate", "", { token: fam.body.token, password });
  const tFam = await login({ email: `s161-familia-${tag}@example.invalid` }, L);
  const content = { shift: { scheduledStart: iso(-120), scheduledEnd: iso(-60) }, organization: { name: `Práctica Lucía ${tag}` }, recipient: { name: "Carmen F." }, caregiver: { name: "Lucía" }, sections: {}, times: {}, incidents: [] };
  const rep = (await q<{ id: string; generated_at: string }>(`INSERT INTO shift_reports (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, content, version, status)
    VALUES ($1,$2,$3,$4,$5::jsonb,1,'DRAFT') RETURNING id, generated_at`, [L, s0, lMem.id, clientId, JSON.stringify(content)])).rows[0];
  const famBefore = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports`, tFam);
  const selfApprove = await call("POST", `/organizations/${L}/shift-reports/${rep.id}/approve`, tL, { expectedGeneratedAt: rep.generated_at, familySections: { schedule: true } });
  const publish = await call("POST", `/organizations/${L}/shift-reports/${rep.id}/publish-as-provider`, tL, { expectedGeneratedAt: rep.generated_at, familySections: { schedule: true } });
  const famList = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports`, tFam);
  const famOne = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports/${rep.id}`, tFam);
  const famPdf = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports/${rep.id}/pdf`, tFam);
  const listBody = JSON.stringify(famList.body);
  check("C17. Publica su informe directo a la familia como «Informe del proveedor» (la vía de «aprobar» sigue prohibiéndose a uno mismo)",
    fam.status === 201 && [200, 201].includes(famAct.status) && JSON.stringify(famBefore.body).indexOf(rep.id) === -1 && selfApprove.status === 403 && selfApprove.body.error === "SHIFT_REPORT_SELF_APPROVAL"
    && publish.status === 200 && publish.body.report?.publishedByProvider === true && publish.body.report?.status === "APPROVED",
    [fam.status, famAct.status, selfApprove.status, selfApprove.body.error, publish.status, publish.body.error]);
  check("C18. La familia lo ve marcado «del proveedor» en la lista, el detalle y el PDF",
    famList.status === 200 && listBody.includes(rep.id) && /"publishedByProvider":true/.test(listBody) && famOne.status === 200 && JSON.stringify(famOne.body).includes('"publishedByProvider":true')
    && famPdf.status === 200 && famPdf.type.includes("pdf"), [famList.status, famOne.status, famPdf.status, famPdf.type]);
  const otherFam = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports`, tA);
  const wrongClient = await call("GET", `/organizations/${N}/care-recipients/${recNId}/shift-reports`, tFam);
  check("C20. Acceso familiar aislado: otra organización y otra persona atendida no ven el informe", [403, 404].includes(otherFam.status) && [403, 404].includes(wrongClient.status), [otherFam.status, wrongClient.status]);
  const client2 = (await call("POST", `/organizations/${L}/care-recipients`, tL, { firstName: "Otra", lastName: "Clienta" })).body;
  const client2Id = (client2.careRecipient ?? client2.recipient ?? client2).id as string;
  const famOther = await call("GET", `/organizations/${L}/care-recipients/${client2Id}/shift-reports`, tFam);
  const famOtherOne = await call("GET", `/organizations/${L}/care-recipients/${client2Id}/shift-reports/${rep.id}`, tFam);
  check("C34. Dentro de la misma práctica, la familia solo consulta los informes de SU persona atendida (otra clienta del mismo proveedor: no)",
    [403, 404].includes(famOther.status) && [403, 404].includes(famOtherOne.status), [famOther.status, famOtherOne.status]);
  const republish = await call("POST", `/organizations/${L}/shift-reports/${rep.id}/publish-as-provider`, tL, { expectedGeneratedAt: rep.generated_at, familySections: { schedule: true } });
  const mutate = await asApp(lucia.id, L, `UPDATE shift_reports SET published_by_provider=false WHERE id='${rep.id}'`);
  check("C21. Publicado no cambia: ni se publica dos veces ni se le quita la marca", republish.status === 409 && mutate.includes("SHIFT_REPORT_APPROVED_IMMUTABLE"), [republish.status, mutate]);

  // ---- 7. Agencias y hogares intactos ------------------------------------------------------------------------------
  await feature(A, "SHIFT_REPORTS");
  const adminAWorker = (await q<{ id: string }>(`INSERT INTO workers (user_id) VALUES ($1) RETURNING id`, [adminA.id])).rows[0].id;
  await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code='WORKER'`, [adminAMem, A]);
  const adminAOwm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','CNA') RETURNING id`, [adminAWorker, A])).rows[0].id;
  const repA = (await q<{ id: string; generated_at: string }>(`INSERT INTO shift_reports (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, content, version, status)
    VALUES ($1,$2,$3,$4,$5::jsonb,1,'DRAFT') RETURNING id, generated_at`, [A, shAId, adminAOwm, recAId, JSON.stringify(content)])).rows[0];
  const aSelf = await call("POST", `/organizations/${A}/shift-reports/${repA.id}/approve`, tA, { expectedGeneratedAt: repA.generated_at, familySections: { schedule: true } });
  const aProvider = await call("POST", `/organizations/${A}/shift-reports/${repA.id}/publish-as-provider`, tA, { expectedGeneratedAt: repA.generated_at, familySections: { schedule: true } });
  const aProviderDb = await asApp(adminA.id, A, `UPDATE shift_reports SET published_by_provider=true WHERE id='${repA.id}'`);
  const aOwnCred = await asApp(adminA.id, A, `INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status) VALUES ('${adminAWorker}','${typeId}','external_provider','active')`);
  const aOwnDecl = await asApp(adminA.id, A, insDeclared(adminAWorker));
  check("C22. Agencia intacta: su administradora no aprueba el informe de su propia visita, no puede «publicar como proveedor» (API ni base), no gestiona sus propias credenciales ni puede autodeclararlas",
    aSelf.status === 403 && aSelf.body.error === "SHIFT_REPORT_SELF_APPROVAL" && aProvider.status === 403 && aProviderDb.includes("SHIFT_REPORT_PROVIDER_PUBLISH_INDEPENDENT_ONLY")
    && aOwnCred.includes("CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN") && aOwnDecl.includes("CREDENTIAL_SELF_DECLARATION_FORBIDDEN"), [aSelf.status, aProvider.status, aProviderDb, aOwnCred, aOwnDecl]);
  const fakeConfirm = await asApp(adminA.id, A, `UPDATE assignments SET self_declaration_confirmed_at = now() WHERE shift_id='${shAId}'`);
  check("C33. En una agencia nadie puede marcar una «confirmación de autodeclaración» para saltarse la elegibilidad al iniciar la visita (base de datos)",
    fakeConfirm.includes("SELF_DECLARATION_INDEPENDENT_ONLY"), fakeConfirm);
  const reqA = await asApp(adminA.id, A, `INSERT INTO requirements (requirement_set_id, credential_type_id, is_mandatory, requires_organization_review) VALUES ('${setA}','${typeId}',false,true)`);
  const hDocs = await call("GET", `/organizations/${H}/practice/documents`, tH);
  const hSelf = await call("POST", `/organizations/${H}/me/shifts/${randomUUID()}/self-assign`, tH, {});
  check("C23. Agencias y hogares: siguen pudiendo exigir revisión de la organización; «Mis documentos» y la autoasignación no existen para ellos",
    !reqA.includes("INDEPENDENT_REQUIREMENT_NO_REVIEW") && hDocs.status === 403 && hSelf.status === 403, [reqA, hDocs.status, hSelf.status]);
  const anaEligAAfter = await call("GET", `/organizations/${A}/workers/${anaMemA}/compliance`, tA);
  check("C24. La agencia sigue aplicando SU política a Ana con normalidad (revisada → elegible)", anaEligAAfter.body.eligibility === "eligible", anaEligAAfter.body);
  // ---- 8. Revisión final: adjuntos con el almacenamiento existente, reinicio de revisiones, acceso, nombre ----------
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const upload = async (o: string, token: string, credId: string) => {
    const init = await call("POST", `/organizations/${o}/me/credentials/${credId}/documents/upload-url`, token, { originalFilename: "certificado.pdf", contentType: "application/pdf", sizeBytes: pdf.byteLength });
    const fileId = init.body.upload?.fileId as string | undefined;
    const put = fileId ? await call("POST", `/organizations/${o}/me/credentials/${credId}/documents/${fileId}/content`, token, pdf) : { status: 0, body: {} as Json, type: "" };
    const done = fileId ? await call("POST", `/organizations/${o}/me/credentials/${credId}/documents/${fileId}/complete`, token) : { status: 0, body: {} as Json, type: "" };
    return { init, put, done, fileId };
  };
  const upL = await upload(L, tL, r1.body.id);
  const lDocRow = await q<{ document_id: string | null; declared_by_holder: boolean }>(`SELECT document_id, declared_by_holder FROM credentials WHERE id=$1`, [r1.body.id]);
  check("C26. Adjunta su archivo a un documento autodeclarado con el almacenamiento seguro existente (S3 privado); sigue siendo autodeclarado",
    upL.init.status === 201 && upL.put.status === 200 && upL.done.status === 200 && Boolean(lDocRow.rows[0]?.document_id) && lDocRow.rows[0]?.declared_by_holder === true,
    [upL.init.status, upL.init.body.error, upL.put.status, upL.done.status, upL.done.body.error]);
  // Acceso al archivo: la agencia donde Ana trabaja (autorizada), sí; un hogar ajeno, una agencia sin vínculo y la familia, no.
  const upA = await upload(N, tAnaN, anaDecl.body.id);
  const dlAgency = await call("POST", `/organizations/${A}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/${upA.fileId}/download-url`, tA, {});
  const dlHome = await call("POST", `/organizations/${H}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/${upA.fileId}/download-url`, tH, {});
  const dlLucia = await call("POST", `/organizations/${L}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/${upA.fileId}/download-url`, tL, {});
  const dlFamily = await call("POST", `/organizations/${L}/workers/${lMem.worker_id}/credentials/${r1.body.id}/documents/${upL.fileId}/download-url`, tFam, {});
  const listFamily = await call("GET", `/organizations/${L}/workers/${lMem.worker_id}/credentials`, tFam);
  check("C27. Documentos de una práctica: solo los ven las organizaciones autorizadas (donde la persona trabaja); ni un hogar ajeno, ni otra independiente, ni la familia",
    upA.done.status === 200 && dlAgency.status === 200 && [403, 404].includes(dlHome.status) && [403, 404].includes(dlLucia.status) && [403, 404].includes(dlFamily.status) && [403, 404].includes(listFamily.status),
    [upA.done.status, dlAgency.status, dlHome.status, dlLucia.status, dlFamily.status, listFamily.status]);
  // La aprobación de la agencia no sobrevive a cambios de la titular (datos ni evidencia).
  const revBefore = await q<{ s: string }>(`SELECT review_status::text s FROM organization_credential_reviews WHERE credential_id=$1 AND organization_id=$2`, [anaDecl.body.id, A]);
  await q(`UPDATE organization_credential_reviews SET review_status='approved', reviewed_at=now() WHERE credential_id=$1 AND organization_id=$2`, [anaDecl.body.id, A]);
  const eligBeforeChange = await call("GET", `/organizations/${A}/workers/${anaMemA}/compliance`, tA);
  const change = await call("PATCH", `/organizations/${N}/practice/documents/${anaDecl.body.id}`, tAnaN, { expiresAt: day(900) });
  const revAfter = await q<{ s: string }>(`SELECT review_status::text s FROM organization_credential_reviews WHERE credential_id=$1 AND organization_id=$2`, [anaDecl.body.id, A]);
  const eligAfterChange = await call("GET", `/organizations/${A}/workers/${anaMemA}/compliance`, tA);
  await q(`UPDATE organization_credential_reviews SET review_status='approved', reviewed_at=now() WHERE credential_id=$1 AND organization_id=$2`, [anaDecl.body.id, A]);
  const reup = await upload(N, tAnaN, anaDecl.body.id);
  const revAfterFile = await q<{ s: string }>(`SELECT review_status::text s FROM organization_credential_reviews WHERE credential_id=$1 AND organization_id=$2`, [anaDecl.body.id, A]);
  check("C28. Si la titular cambia los datos o el archivo de un autodeclarado, la aprobación de la agencia vuelve a «pendiente» y deja de contar allí",
    revBefore.rows[0]?.s === "pending" && eligBeforeChange.body.eligibility === "eligible" && change.status === 200 && revAfter.rows[0]?.s === "pending"
    && eligAfterChange.body.eligibility === "not_eligible" && reup.done.status === 200 && revAfterFile.rows[0]?.s === "pending",
    [revBefore.rows, eligBeforeChange.body.eligibility, change.status, revAfter.rows, eligAfterChange.body.eligibility, reup.done.status, revAfterFile.rows]);
  const agencyAttach = await call("POST", `/organizations/${A}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/upload-url`, tA, { originalFilename: "x.pdf", contentType: "application/pdf", sizeBytes: pdf.byteLength });
  const agencyAttachDone = agencyAttach.body.upload?.fileId
    ? await (async () => { await call("POST", `/organizations/${A}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/${agencyAttach.body.upload.fileId}/content`, tA, pdf);
        return call("POST", `/organizations/${A}/workers/${anaWorker}/credentials/${anaDecl.body.id}/documents/${agencyAttach.body.upload.fileId}/complete`, tA); })()
    : agencyAttach as { status: number; body: Json };
  await rt.query("BEGIN"); await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.current_org_id',$2,true)`, [lucia.id, L]);
  const probeOther = (await rt.query<{ v: boolean }>(`SELECT public.app_is_independent_operator($1::uuid, $2::uuid) AS v`, [ana.id, N])).rows[0].v;
  const probeSelf = (await rt.query<{ v: boolean }>(`SELECT public.app_is_independent_operator($1::uuid, $2::uuid) AS v`, [lucia.id, L])).rows[0].v;
  await rt.query("ROLLBACK");
  const probe = probeOther === false && probeSelf === true ? "OK" : `other=${probeOther} self=${probeSelf}`;
  check("C29. Nadie más adjunta archivos a un autodeclarado (tampoco su agencia), y la función del operador no sirve para sondear a otra cuenta",
    agencyAttachDone.status !== 200 && probe === "OK", [agencyAttach.status, agencyAttachDone.status, agencyAttachDone.body.error, probe]);
  // Nombre profesional en el «Informe del proveedor».
  // Informe REAL de una visita terminada (inicio y final), generado por el backend sin nombre profesional.
  const shN2 = await newShift(tL, L, clientId, 2, 62);
  const sa2 = await call("POST", `/organizations/${L}/me/shifts/${shN2}/self-assign`, tL, { confirmSelfDeclaration: true });
  const ci2 = await call("POST", `/organizations/${L}/shifts/${shN2}/check-in`, tL, { verificationMethodCode: "CAREGIVER_SESSION" });
  await call("POST", `/organizations/${L}/shifts/${shN2}/care-events`, tL, { typeCode: "MEAL", careRecipientId: clientId, payload: { mealType: "Cena", amountConsumed: "Todo" } });
  const co2 = await call("POST", `/organizations/${L}/shifts/${shN2}/check-out`, tL, {});
  const en2 = await call("GET", `/organizations/${L}/shifts/${shN2}/shift-reports`, tL);
  if (process.env.S161_DEBUG) console.log("visita", sa2.status, sa2.body.error, ci2.status, ci2.body.error, co2.status, co2.body.error, en2.status, en2.body.error);
  const confirmedAt = await q<{ c: string | null }>(`SELECT self_declaration_confirmed_at c FROM assignments WHERE shift_id=$1`, [shN2]);
  check("C32. Quien confirmó al asignarse puede iniciar y terminar esa visita (la confirmación queda en la asignación); sin confirmación, la regla de elegibilidad sigue igual",
    sa2.status === 201 && ci2.status === 201 && co2.status === 201 && Boolean(confirmedAt.rows[0]?.c), [sa2.status, ci2.status, ci2.body.error, co2.status, confirmedAt.rows]);
  const repN = (await q<{ id: string; generated_at: string }>(`SELECT id, generated_at FROM shift_reports WHERE shift_id=$1`, [shN2])).rows[0] ?? { id: randomUUID(), generated_at: new Date().toISOString() };
  const pubNoName = await call("POST", `/organizations/${L}/shift-reports/${repN.id}/publish-as-provider`, tL, { expectedGeneratedAt: repN.generated_at, familySections: { schedule: true } });
  const dbNoName = await asApp(lucia.id, L, `UPDATE shift_reports SET status='APPROVED', approved_at=now(), approved_by_user_id='${lucia.id}', published_by_provider=true, family_sections='{}'::jsonb WHERE id='${repN.id}'`);
  const setName = await call("PUT", `/organizations/${L}/practice/profile`, tL, { professionalName: "Lucía Rivera, CNA" });
  const docsName = await call("GET", `/organizations/${L}/practice/documents`, tL);
  const refreshed = await call("POST", `/organizations/${L}/shift-reports/${repN.id}/refresh`, tL, {});
  const fresh = await q<{ generated_at: string; name: string | null }>(`SELECT generated_at, content->'caregiver'->>'name' AS name FROM shift_reports WHERE id=$1`, [repN.id]);
  const pubNamed = await call("POST", `/organizations/${L}/shift-reports/${repN.id}/publish-as-provider`, tL, { expectedGeneratedAt: fresh.rows[0].generated_at, familySections: { schedule: true } });
  const famNamed = await call("GET", `/organizations/${L}/care-recipients/${clientId}/shift-reports/${repN.id}`, tFam);
  const nameAudit = await q(`SELECT 1 FROM audit_log WHERE action='PRACTICE_PROFESSIONAL_NAME_SET' AND organization_id=$1`, [L]);
  check("C30. Nunca «Cuidador: —»: sin nombre profesional no se publica (API y base); con su nombre (auditado) se actualiza el informe y la familia lo ve",
    pubNoName.status === 409 && pubNoName.body.error === "PROVIDER_NAME_REQUIRED" && dbNoName.includes("PROVIDER_NAME_REQUIRED") && setName.status === 200
    && docsName.body.professionalName === "Lucía Rivera, CNA" && [200, 204].includes(refreshed.status) && fresh.rows[0].name === "Lucía Rivera, CNA"
    && pubNamed.status === 200 && JSON.stringify(famNamed.body).includes("Lucía Rivera, CNA") && nameAudit.rowCount === 1,
    [pubNoName.status, pubNoName.body.error, dbNoName, setName.status, refreshed.status, refreshed.body, fresh.rows[0]?.name, pubNamed.status, pubNamed.body.error, famNamed.status]);
  const otherName = await call("PUT", `/organizations/${A}/practice/profile`, tA, { professionalName: "Intento" });
  check("C31. Solo la propia persona operativa cambia su nombre profesional (una agencia, no)", otherName.status === 403, otherName);

  check("C25. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rt.end(); await db.end(); moto?.kill();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 1200)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  moto?.kill();
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); moto?.kill(); process.exit(1); });

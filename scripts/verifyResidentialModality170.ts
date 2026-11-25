/**
 * 170 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F0: base de aislamiento. 24-nov-2026.
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: app_org_is_residential, interruptores de hogar apagados por defecto, guarda de modalidad (backend y base,
 * también para el superusuario), rutas /residential solo para hogares, lista de módulos denegados en hogares,
 * panel base del hogar (solo administración, recuentos, aviso del plan), aislamiento entre las tres modalidades,
 * NO REGRESIÓN de agencias e independientes, tabla shifts intacta, reversión e idempotencia.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  if (url.startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.EMAIL_SENDER_ADDRESS ??= "pruebas@example.invalid";
process.env.ACTIVATION_BASE_URL ??= "https://portal.example.invalid";

const ORIGINAL_CODES = ["ACTIVITY_PHOTOS", "CONTRACTS", "EN_CAMINO", "FACTURACION", "FINANZAS", "PUSH_NOTIFICATIONS", "SHIFT_REPORTS", "SMARTMATCH"];
const HOGAR_CODES = ["DEMO_ENVIRONMENT", "HOGAR_ASIGNACIONES", "HOGAR_CALENDARIO", "HOGAR_PONCHES"];
const DENIED_CODES = ["FACTURACION", "FINANZAS", "SHIFT_REPORTS", "SMARTMATCH"];

async function freshDb(srv: pg.Client, prefix: string) {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${name}`);
  const u = new URL(serverUrl!); u.pathname = `/${name}`;
  const m = new pg.Client({ connectionString: u.toString() }); await m.connect();
  const log = console.log; console.log = () => undefined;
  try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; }
  return { name, url: u.toString(), client: m };
}

const shiftsShape = async (c: pg.Client) => (await c.query<{ s: string }>(`SELECT md5(concat_ws('|',
  (SELECT string_agg(column_name||data_type||is_nullable||COALESCE(column_default,''), ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='shifts'),
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.shifts'::regclass AND NOT tgisinternal),
  (SELECT string_agg(policyname||qual||COALESCE(with_check,''), ',' ORDER BY policyname) FROM pg_policies WHERE tablename='shifts'),
  (SELECT string_agg(conname||pg_get_constraintdef(oid), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid='public.shifts'::regclass))) s`)).rows[0].s;

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();

  // ======== Parte 1: reversión e idempotencia, en una base desechable propia ==================================
  {
    const r = await freshDb(srv, "etnara_h170rb");
    const c = r.client;
    const applied = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename='170_residential_modality_foundation.sql'`)).rowCount === 1;
    const shapeWith = await shiftsShape(c);
    const rollback = readFileSync(join(process.cwd(), "ops/170_residential_modality_foundation.rollback.sql"), "utf8");
    // Con un interruptor de hogar registrado (aunque apagado) la reversión se niega.
    const ag = (await c.query<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ('Agencia RB','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_PONCHES',false)`, [ag]);
    let refused = ""; try { await c.query(rollback); } catch (e) { refused = (e as Error).message; await c.query("ROLLBACK").catch(() => undefined); }
    const stillThere = (await c.query(`SELECT to_regprocedure('public.app_org_is_residential(uuid)') IS NOT NULL ok`)).rows[0].ok === true;
    check("R1. La reversión se NIEGA si existe cualquier interruptor de hogar (no borra historial) y no deja nada a medias", refused.includes("ROLLBACK_170_REFUSED") && stillThere, refused);
    await c.query(`DELETE FROM organization_features WHERE feature_code='HOGAR_PONCHES'`);
    await c.query(rollback);
    const gone = (await c.query<{ f: boolean; g: boolean; t: number; k: string; m: number }>(`SELECT
      to_regprocedure('public.app_org_is_residential(uuid)') IS NULL f,
      to_regprocedure('public.app_org_feature_modality_guard()') IS NULL g,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname='organization_features_modality_guard') t,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='organization_features_feature_code_check') k,
      (SELECT count(*)::int FROM schema_migrations WHERE filename='170_residential_modality_foundation.sql') m`)).rows[0];
    let hogarAfter = ""; try { await c.query(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_PONCHES',false)`, [ag]); hogarAfter = "OK"; } catch (e) { hogarAfter = (e as Error).message; }
    check("R2. Sin interruptores de hogar, la reversión retira función, guarda, códigos y registro (vuelven los 8 códigos)",
      applied && gone.f && gone.g && gone.t === 0 && gone.m === 0 && !gone.k.includes("HOGAR") && gone.k.includes("CONTRACTS") && hogarAfter.includes("check constraint"), [gone, hogarAfter]);
    check("R3. La tabla shifts es idéntica con y sin la 170 (columnas, disparadores, políticas y restricciones)", (await shiftsShape(c)) === shapeWith);
    const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(c, join(process.cwd(), "migrations")); } finally { console.log = log; }
    const sql170 = readFileSync(join(process.cwd(), "migrations/170_residential_modality_foundation.sql"), "utf8");
    let twice = "OK"; try { await c.query(sql170); } catch (e) { twice = (e as Error).message; }
    check("R4. Se vuelve a aplicar tras la reversión y es idempotente (dos veces seguidas sin error)",
      (await c.query(`SELECT 1 FROM schema_migrations WHERE filename='170_residential_modality_foundation.sql'`)).rowCount === 1 && twice === "OK", twice);
    await c.end(); await srv.query(`DROP DATABASE ${r.name} WITH (FORCE)`);
  }

  // ======== Parte 2: aplicación real por HTTP como app_runtime =================================================
  const own = await freshDb(srv, "etnara_h170");
  await own.client.end();
  const db = new pg.Client({ connectionString: own.url }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(own.url); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();
  const rtErr = async (s: string, p: unknown[] = []) => { try { await rt.query(s, p); return "OK"; } catch (e) { return (e as Error).message; } };
  const suErr = async (s: string, p: unknown[] = []) => { try { await q(s, p); return "OK"; } catch (e) { return (e as Error).message; } };

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
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let json: Json = {}; try { json = JSON.parse(await res.text()); } catch { /* vacío */ }
    if (res.status >= 500) errors500.push(`${method} ${path} ${res.status}`);
    return { status: res.status, body: json };
  }
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `h170-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: x.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };

  // Base ficticia: una agencia, un hogar, una práctica independiente (creada en la base: la modalidad 160 se
  // enciende solo aquí, en esta base desechable, y se apaga enseguida), y ETNARA Central.
  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY"), H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME");
  // 163: encender exige una autorización de activación vigente (segundo candado), también para el propietario.
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  const adminA = await user("admin-agencia"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminH = await user("admin-hogar"); await member(adminH, H, ["ORGANIZATION_ADMIN"]);
  const supH = await user("supervisora-hogar"); await member(supH, H, ["SUPERVISOR"]);
  const famH = await user("familiar-hogar"); await member(famH, H, ["FAMILY_MEMBER"]);
  const adminI = await user("independiente"); await member(adminI, I, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tC = await login(central), tA = await login(adminA, A), tH = await login(adminH, H), tS = await login(supH, H), tF = await login(famH, H), tI = await login(adminI, I);

  // ---- Base de datos ------------------------------------------------------------------------------------------
  const fn = (await q<{ secdef: boolean; path: string; pub: boolean; rt: boolean }>(`SELECT p.prosecdef secdef, array_to_string(p.proconfig, ',') path,
      has_function_privilege('public', p.oid, 'EXECUTE') pub, has_function_privilege('app_runtime', p.oid, 'EXECUTE') rt
    FROM pg_proc p WHERE p.oid = 'public.app_org_is_residential(uuid)'::regprocedure`)).rows[0];
  check("S1. app_org_is_residential: SECURITY DEFINER, search_path fijo, sin PUBLIC, solo app_runtime ejecuta", fn?.secdef === true && fn.path.includes("search_path=pg_catalog, public") && fn.pub === false && fn.rt === true, fn);
  const isRes = async (o: string) => (await rt.query<{ r: boolean }>(`SELECT app_org_is_residential($1::uuid) r`, [o])).rows[0].r;
  check("S2. Solo el hogar es residencial (agencia, independiente y una organización inexistente: false)",
    (await isRes(H)) === true && (await isRes(A)) === false && (await isRes(I)) === false && (await isRes(randomUUID())) === false);
  check("S3. Interruptores de hogar apagados por defecto: ninguna fila ni evento con los códigos nuevos",
    (await q(`SELECT 1 FROM organization_features WHERE feature_code = ANY($1)`, [HOGAR_CODES])).rowCount === 0
    && (await q(`SELECT 1 FROM organization_feature_events WHERE feature_code = ANY($1)`, [HOGAR_CODES])).rowCount === 0);
  check("S4. La aplicación (app_runtime) no escribe interruptores (solo ETNARA Central, RLS de 108)",
    (await rtErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_PONCHES',true)`, [H])) !== "OK");
  check("S5. Guarda en la base (incluso superusuario): HOGAR_* y DEMO_ENVIRONMENT no se encienden en agencias ni independientes",
    (await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_CALENDARIO',true)`, [A])).includes("FEATURE_NOT_AVAILABLE_FOR_MODALITY")
    && (await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'DEMO_ENVIRONMENT',true)`, [I])).includes("FEATURE_NOT_AVAILABLE_FOR_MODALITY"));
  const deniedDb: string[] = [];
  for (const code of DENIED_CODES.filter((c) => c !== "FACTURACION")) deniedDb.push(await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,$2,true)`, [H, code]));
  // FACTURACION exige FINANZAS (otra guarda, 123): se aísla la guarda de la 170 con FINANZAS presente, en una transacción que se deshace.
  await q("BEGIN");
  await q(`ALTER TABLE organization_features DISABLE TRIGGER organization_features_modality_guard`);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'FINANZAS',true)`, [H]);
  await q(`ALTER TABLE organization_features ENABLE TRIGGER organization_features_modality_guard`);
  await q("SAVEPOINT f");
  deniedDb.push(await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'FACTURACION',true)`, [H]));
  await q("ROLLBACK");
  check("S6. Guarda en la base: SMARTMATCH, FINANZAS, FACTURACION y SHIFT_REPORTS no se encienden en un hogar", deniedDb.length === 4 && deniedDb.every((e) => e.includes("FEATURE_NOT_AVAILABLE_FOR_MODALITY")), deniedDb);
  check("S7. Apagar nunca se bloquea: crear apagado un código de otra modalidad se admite",
    (await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'HOGAR_PONCHES',false)`, [A])) === "OK"
    && (await suErr(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'FINANZAS',false)`, [H])) === "OK");
  await q(`DELETE FROM organization_features WHERE (organization_id=$1 AND feature_code='HOGAR_PONCHES') OR (organization_id=$2 AND feature_code='FINANZAS')`, [A, H]);

  // ---- ETNARA Central -----------------------------------------------------------------------------------------
  const codes = async (o: string) => ((await call("GET", `/platform/organizations/${o}/features`, tC)).body.features ?? []).map((f: Json) => `${f.code}:${f.enabled}`).sort();
  const listA = await codes(A), listI = await codes(I), listH = await codes(H);
  check("C1. Central: agencia e independiente ven exactamente los 8 interruptores de siempre (sin códigos de hogar)",
    JSON.stringify(listA) === JSON.stringify(ORIGINAL_CODES.map((c) => `${c}:false`)) && JSON.stringify(listI) === JSON.stringify(listA), [listA, listI]);
  const expectedH = [...ORIGINAL_CODES.filter((c) => !DENIED_CODES.includes(c)), ...HOGAR_CODES].sort().map((c) => `${c}:false`);
  check("C2. Central: el hogar ve sus 4 interruptores (apagados) y no ve los módulos denegados", JSON.stringify(listH) === JSON.stringify(expectedH), listH);
  const put = (o: string, code: string, enabled: boolean, t = tC) => call("PUT", `/platform/organizations/${o}/features/${code}`, t, { enabled, reason: "Prueba ficticia 170" });
  const pA = await put(A, "HOGAR_CALENDARIO", true), pI = await put(I, "DEMO_ENVIRONMENT", true);
  check("C3. Central no enciende un interruptor de hogar en agencia ni independiente (409 FEATURE_NOT_AVAILABLE_FOR_MODALITY)",
    pA.status === 409 && pA.body.error === "FEATURE_NOT_AVAILABLE_FOR_MODALITY" && pI.status === 409 && pI.body.error === "FEATURE_NOT_AVAILABLE_FOR_MODALITY", [pA, pI]);
  const pD = await Promise.all(DENIED_CODES.map((code) => put(H, code, true)));
  check("C4. Central no enciende Finanzas, Facturación, SmartMatch ni Informe de Turno en un hogar", pD.every((r) => r.status === 409 && r.body.error === "FEATURE_NOT_AVAILABLE_FOR_MODALITY"), pD.map((r) => r.status));
  const notCentral = await put(H, "HOGAR_CALENDARIO", true, tH);
  check("C5. La administración del hogar no puede encender sus propios interruptores (solo ETNARA Central)", notCentral.status === 403, notCentral);
  // Ninguna administración de organización enciende sus propios interruptores (solo ETNARA Central).
  const selfPuts = [await put(H, "HOGAR_PONCHES", true, tS), await put(H, "DEMO_ENVIRONMENT", true, tH), await put(A, "SMARTMATCH", true, tA), await put(I, "EN_CAMINO", true, tI)];
  check("P1. Ninguna administración (hogar, supervisora, agencia, independiente) cambia sus interruptores por la API: 403 PLATFORM_ADMIN_REQUIRED",
    selfPuts.every((r) => r.status === 403 && r.body.error === "PLATFORM_ADMIN_REQUIRED"), selfPuts.map((r) => `${r.status}:${r.body.error}`));
  const forged = async (stmt: string, params: unknown[]) => {
    try {
      await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true), set_config('app.is_superadmin', 'true', true)`, [adminH.id, H]);
      await rt.query(stmt, params); await rt.query("ROLLBACK"); return "OK";
    } catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as Error).message; }
  };
  const fIns = await forged(`INSERT INTO organization_features (organization_id, feature_code, enabled, updated_by_user_id) VALUES ($1,'HOGAR_PONCHES',true,$2)`, [H, adminH.id]);
  const fEv = await forged(`INSERT INTO organization_feature_events (organization_id, feature_code, enabled, reason, actor_user_id) VALUES ($1,'HOGAR_PONCHES',true,'forjado',$2)`, [H, adminH.id]);
  check("P2. Ni siquiera con el contexto de su hogar y app.is_superadmin forjado en la conexión de la app: RLS rechaza interruptor y evento",
    fIns.includes("row-level security") && fEv.includes("row-level security"), [fIns, fEv]);
  const fUpd = await forged(`UPDATE organization_features SET enabled=true WHERE organization_id=$1`, [H]);
  check("P3. Tampoco puede modificar filas existentes (0 filas visibles para escribir) y no queda nada escrito",
    fUpd === "OK" && (await q(`SELECT 1 FROM organization_features WHERE organization_id=$1 AND enabled`, [H])).rowCount === 0, fUpd);
  const unknown = await put(H, "HOGAR_INVENTADO", true);
  check("C6. Un código inexistente se rechaza (400)", unknown.status === 400, unknown);
  const agencyFin = await put(A, "FINANZAS", true);
  check("N1. No regresión: Central sigue encendiendo Finanzas en una agencia", agencyFin.status === 200 && agencyFin.body.feature?.enabled === true, agencyFin);

  // ---- Rutas /residential: solo hogares -----------------------------------------------------------------------
  for (let i = 0; i < 11; i += 1) await q(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,$2,'Ficticio','active')`, [H, `Residente${i}`]);
  await q(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,'Persona','Agencia','active')`, [A]);
  const ovH = await call("GET", `/organizations/${H}/residential/overview`, tH);
  const ov = ovH.body.overview ?? {};
  check("H1. Panel base del hogar: 200 para su administración, recuentos administrativos y los 4 interruptores apagados",
    ovH.status === 200 && ov.activeResidents === 11 && ov.planResidentLimit === 10 && ov.overPlanLimit === true
    && JSON.stringify((ov.features ?? []).map((f: Json) => `${f.code}:${f.enabled}`).sort()) === JSON.stringify(HOGAR_CODES.map((c) => `${c}:false`)), ovH);
  check("H2. El panel no expone nombres ni datos de residentes (solo recuentos)", !JSON.stringify(ovH.body).includes("Residente") && !JSON.stringify(ovH.body).includes("Ficticio"));
  const ovS = await call("GET", `/organizations/${H}/residential/overview`, tS), ovF = await call("GET", `/organizations/${H}/residential/overview`, tF);
  check("H3. Supervisora del hogar: 200; familiar del hogar: 403 RESIDENTIAL_MANAGER_REQUIRED", ovS.status === 200 && ovF.status === 403 && ovF.body.error === "RESIDENTIAL_MANAGER_REQUIRED", [ovS.status, ovF]);
  const ovA = await call("GET", `/organizations/${A}/residential/overview`, tA), ovI = await call("GET", `/organizations/${I}/residential/overview`, tI);
  check("H4. Agencia e independiente: /residential responde 403 MODALITY_NOT_AVAILABLE", ovA.status === 403 && ovA.body.error === "MODALITY_NOT_AVAILABLE" && ovI.status === 403 && ovI.body.error === "MODALITY_NOT_AVAILABLE", [ovA, ovI]);
  const caseA = await call("GET", `/organizations/${A.toUpperCase()}/RESIDENTIAL/Overview`, tA);
  check("H5. Mayúsculas no saltan la regla (enrutado sin distinción de mayúsculas)", caseA.status === 403 && caseA.body.error === "MODALITY_NOT_AVAILABLE", caseA);
  const crossAH = await call("GET", `/organizations/${H}/residential/overview`, tA), crossIH = await call("GET", `/organizations/${H}/residential/overview`, tI);
  check("H6. Quien no es miembro del hogar recibe el 403 de siempre (no se revela el tipo de la organización)",
    crossAH.status === 403 && crossAH.body.error !== "MODALITY_NOT_AVAILABLE" && crossIH.status === 403 && crossIH.body.error !== "MODALITY_NOT_AVAILABLE"
    && JSON.stringify(crossAH.body) === JSON.stringify(crossIH.body), [crossAH, crossIH]);
  const noToken = await call("GET", `/organizations/${H}/residential/overview`, "");
  check("H7. Sin sesión: 401 (la ruta responde lo suyo)", noToken.status === 401, noToken);

  // ---- Lista de módulos denegados en hogares --------------------------------------------------------------------
  const sh = randomUUID(), rc = randomUUID();
  const deniedPaths = (o: string) => [
    ["GET", `/organizations/${o}/finance/services`], ["GET", `/organizations/${o}/shifts/${sh}/finance`],
    ["GET", `/organizations/${o}/billing/access`], ["POST", `/organizations/${o}/billing/tax`],
    ["GET", `/organizations/${o}/smartmatch/opportunities`], ["GET", `/organizations/${o}/shifts/${sh}/private-instructions`],
    ["GET", `/organizations/${o}/shift-reports`], ["GET", `/organizations/${o}/shifts/${sh}/shift-reports`],
    ["GET", `/organizations/${o}/shift-report-access`], ["GET", `/organizations/${o}/me/shift-reports`],
    ["GET", `/organizations/${o}/care-recipients/${rc}/shift-reports`],
  ] as const;
  const hRes = await Promise.all(deniedPaths(H).map(([m, p]) => call(m, p, tH, m === "POST" ? {} : undefined)));
  check("D1. Hogar: Finanzas, Facturación, SmartMatch e Informe de Turno responden 403 MODALITY_NOT_AVAILABLE (todas las rutas y métodos)",
    hRes.every((r) => r.status === 403 && r.body.error === "MODALITY_NOT_AVAILABLE"), hRes.map((r) => `${r.status}:${r.body.error}`));
  const aRes = await Promise.all(deniedPaths(A).map(([m, p]) => call(m, p, tA, m === "POST" ? {} : undefined)));
  check("D2. Agencia: ninguna de esas rutas responde MODALITY_NOT_AVAILABLE (decide su interruptor, como hoy)",
    aRes.every((r) => r.body.error !== "MODALITY_NOT_AVAILABLE" && r.status < 500), aRes.map((r) => `${r.status}:${r.body.error ?? "ok"}`));
  const finA = await call("GET", `/organizations/${A}/finance/services`, tA), smA = await call("GET", `/organizations/${A}/smartmatch/opportunities`, tA);
  check("D3. Agencia: Finanzas encendida → 200; SmartMatch apagado → 404 FEATURE_NOT_ENABLED (sin cambios)", finA.status === 200 && smA.status === 404 && smA.body.error === "FEATURE_NOT_ENABLED", [finA.status, smA]);
  const iRes = await Promise.all(deniedPaths(I).map(([m, p]) => call(m, p, tI, m === "POST" ? {} : undefined)));
  const iSm = iRes[4];
  check("D4. Independiente: igual que antes de la 170 (SmartMatch cerrado por la 160; el resto decide su interruptor)",
    iSm.status === 403 && iSm.body.error === "MODALITY_NOT_AVAILABLE" && iRes.filter((_, i) => i !== 4).every((r) => r.body.error !== "MODALITY_NOT_AVAILABLE" && r.status < 500),
    iRes.map((r) => `${r.status}:${r.body.error ?? "ok"}`));
  const xRes = await call("GET", `/organizations/${H}/finance/services`, tA);
  check("D5. Una agencia que pide Finanzas de un hogar recibe el 403 de pertenencia (no el de modalidad)", xRes.status === 403 && xRes.body.error !== "MODALITY_NOT_AVAILABLE", xRes);
  const careH = await call("GET", `/organizations/${H}/care-recipients`, tH), shiftsH = await call("GET", `/organizations/${H}/shifts`, tH);
  check("N2. No regresión del hogar: residentes y turnos siguen abiertos", careH.status === 200 && shiftsH.status === 200, [careH.status, shiftsH.status]);

  // ---- Encendido en esta base desechable (simulación de Central) ---------------------------------------------------
  const onDemo = await put(H, "DEMO_ENVIRONMENT", true), onCal = await put(H, "HOGAR_CALENDARIO", true);
  const ev = await q(`SELECT 1 FROM organization_feature_events WHERE organization_id=$1 AND feature_code IN ('DEMO_ENVIRONMENT','HOGAR_CALENDARIO')`, [H]);
  const meH = await call("GET", "/me", tH);
  check("E1. Encendido por Central en un hogar: queda registrado en el historial (solo anexos)", onDemo.status === 200 && onCal.status === 200 && ev.rowCount === 2, [onDemo.status, onCal.status]);
  check("E2. /me del hogar expone su tipo y DEMO_ENVIRONMENT (el portal muestra la franja de demostración)",
    meH.status === 200 && JSON.stringify(meH.body).includes("RESIDENTIAL_CARE_HOME") && JSON.stringify(meH.body).includes("DEMO_ENVIRONMENT"), meH.body);
  const meA = await call("GET", "/me", tA);
  check("E3. /me de la agencia no contiene ningún código de hogar", meA.status === 200 && !/HOGAR_|DEMO_ENVIRONMENT/.test(JSON.stringify(meA.body)));
  const offDemo = await put(H, "DEMO_ENVIRONMENT", false);
  check("E4. Apagar un interruptor de hogar funciona", offDemo.status === 200 && offDemo.body.feature?.enabled === false, offDemo);

  // ---- Hogar existente con un módulo denegado ya encendido (anterior a la 170) -------------------------------------
  await q(`ALTER TABLE organization_features DISABLE TRIGGER organization_features_modality_guard`);
  await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,'SMARTMATCH',true)`, [H]);
  await q(`ALTER TABLE organization_features ENABLE TRIGGER organization_features_modality_guard`);
  const legacyTouch = await suErr(`UPDATE organization_features SET updated_at=now() WHERE organization_id=$1 AND feature_code='SMARTMATCH'`, [H]);
  const legacyRoute = await call("GET", `/organizations/${H}/smartmatch/opportunities`, tH);
  const legacyOff = await put(H, "SMARTMATCH", false);
  const legacyOn = await put(H, "SMARTMATCH", true);
  check("L1. Fila previa en un hogar: la 170 no la modifica; la ruta queda cerrada por modalidad; Central puede apagarla y no volver a encenderla",
    legacyTouch === "OK" && legacyRoute.status === 403 && legacyRoute.body.error === "MODALITY_NOT_AVAILABLE" && legacyOff.status === 200 && legacyOn.status === 409,
    [legacyTouch, legacyRoute.status, legacyOff.status, legacyOn.status]);

  check("Z1. Nunca un 500 en todo el recorrido", errors500.length === 0, errors500);

  server.close(); await pool.end(); await rt.end(); await db.end();
  await srv.query(`DROP DATABASE ${own.name} WITH (FORCE)`); await srv.end();
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.pass ? "" : `\n      ${r.detail.slice(0, 900)}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  process.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });

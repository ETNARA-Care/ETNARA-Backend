/**
 * Seguridad 25-nov-2026 · guardas por ruta frente a variantes de URL que Express acepta. Datos FICTICIOS, base PROPIA
 * desechable, aplicación real por HTTP como app_runtime; ningún correo real ni salida de red.
 *
 *   G1. orgFeatureGate: con los interruptores apagados, ninguna variante (barra final, mayúsculas, ids codificados…)
 *       ni método llega a una ruta de funcionalidad cerrada.
 *   G2. modalityGate: en un independiente, ninguna variante llega a una ruta de equipo cerrada.
 *   G3. contractEnforcementGate: con «restringir operación nueva» vigente y contrato pendiente, ninguna variante abre
 *       operación nueva; las rutas de contrato y las lecturas siguen permitidas.
 *   G4. Límite de escrituras (L4): las variantes en mayúsculas cuentan igual.
 *   G5. Sin regresión: con los interruptores encendidos, ninguna variante queda cerrada por error.
 *   G6. Cierre ante fallos: sesión inválida → 401 de la ruta; no miembro → 403; fallo inesperado → 503 (nunca sigue).
 *   G7. Estado contractual vacío, incompleto o inválido → 503 y nada se crea; «off» sin fila de modo sigue normal.
 *   G8. No regresión de accesos legítimos: ambos modos contractuales, GET y HEAD, cuidadores (WORKER), familiares
 *       (FAMILY), supervisoras y administración; rutas abiertas de independientes y agencias.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { pathVariants } from "./lib/gatePathVariants.js";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1400) });

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

const ALL_FEATURES = ["ACTIVITY_PHOTOS", "CONTRACTS", "EN_CAMINO", "FINANZAS", "FACTURACION", "PUSH_NOTIFICATIONS", "SHIFT_REPORTS", "SMARTMATCH"];

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const name = `etnara_gatepath_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${name}`);
  const su = new URL(serverUrl!); su.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: su.toString() }); await db.connect();
  { const log = console.log; console.log = () => undefined; try { await applyPendingMigrations(db, join(process.cwd(), "migrations")); } finally { console.log = log; } }
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const rtUrl = new URL(su.toString()); rtUrl.username = "app_runtime"; rtUrl.password = runtimePassword;
  process.env.DATABASE_URL = rtUrl.toString();
  process.env.CONTRACTS_ENFORCEMENT = "on";

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { gatedFeatureFor } = await import("../src/middleware/orgFeatureRules.js");
  const { teamRouteFor } = await import("../src/middleware/modalityRules.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js");
  const { pool } = await import("../src/config/db.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const errors500: string[] = [];
  const send = (method: string, path: string, token: string, body?: Json) => new Promise<{ status: number; json: boolean; body: Json }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => (text += c)); res.on("end", () => {
        const isJson = (res.headers["content-type"] ?? "").includes("application/json");
        let parsed: Json = {}; if (isJson) { try { parsed = JSON.parse(text); } catch { /* vacío */ } }
        if (res.statusCode === 500) errors500.push(`${method} ${path} ${parsed.error ?? ""}`);
        resolve({ status: res.statusCode ?? 0, json: isJson, body: parsed });
      });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
  // node:http envía la ruta tal cual. El límite de escrituras se reinicia en cada petición salvo en G4.
  const raw = (method: string, path: string, token: string, body?: Json) => { resetFeatureWriteLimitForTests(); return send(method, path, token, body); };

  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const org = async (n: string, t: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [n, t])).rows[0].id;
  const user = async (key: string) => { const email = `gp-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); };
  const login = async (x: { email: string }, o: string) => { const t = (await raw("POST", "/auth/login", "", { email: x.email, password })).body.token as string;
    await raw("POST", "/me/active-organization", t, { organizationId: o }); return t; };

  const A = await org(`Agencia apagada ${tag}`, "HOME_CARE_AGENCY"), B = await org(`Agencia encendida ${tag}`, "HOME_CARE_AGENCY");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  // La agencia A tiene todo apagado (incluso lo que una migración pudiera encender por defecto). B tiene todo encendido.
  await q(`DELETE FROM organization_features WHERE organization_id = $1`, [A]);
  for (const code of ALL_FEATURES) await q(`INSERT INTO organization_features (organization_id, feature_code, enabled) VALUES ($1,$2,true) ON CONFLICT (organization_id, feature_code) DO UPDATE SET enabled = true`, [B, code]);
  const adminA = await user("admin-a"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminB = await user("admin-b"); await member(adminB, B, ["ORGANIZATION_ADMIN"]);
  const adminI = await user("indep"); await member(adminI, I, ["ORGANIZATION_ADMIN"]);
  const tA = await login(adminA, A), tB = await login(adminB, B), tI = await login(adminI, I);
  // Estado contractual fijo SOLO en esta base desechable: B en «restringir operación nueva», vigente y pendiente.
  // Tabla de control propia de la prueba: modo, fecha y «satisfecho» por organización; present=false no devuelve fila.
  await q(`CREATE TABLE zz_contract_stub (org uuid PRIMARY KEY, present boolean NOT NULL DEFAULT true, mode text, enforce_from timestamptz, satisfied boolean)`);
  await q(`CREATE OR REPLACE FUNCTION public.app_contract_enforcement_state(p_org uuid)
    RETURNS TABLE(mode text, enforce_from timestamptz, satisfied boolean, pending integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT z.mode, z.enforce_from, z.satisfied, 1 FROM public.zz_contract_stub z WHERE z.org = p_org AND z.present
    UNION ALL SELECT 'off', NULL::timestamptz, true, 0 WHERE NOT EXISTS (SELECT 1 FROM public.zz_contract_stub z WHERE z.org = p_org) $$`);
  await q(`INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ($1, 'restrict_new_operations', now() - interval '1 day', false)`, [B]);

  // ---- Inventario de rutas ---------------------------------------------------------------------------------
  type R = { methods: string[]; path: string };
  const routes: R[] = [];
  const walk = (stack: any[]) => { for (const l of stack) { if (l.route) routes.push({ methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()), path: l.route.path }); else if (l.handle?.stack) walk(l.handle.stack); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  walk((app as any).router.stack); // eslint-disable-line @typescript-eslint/no-explicit-any
  const orgRoutes = routes.filter((r) => r.path.startsWith("/organizations/:organizationId/"));
  const fill = (p: string, orgId: string, ids: string[]) => p.replace(/:([A-Za-z]+)/g, (_m, n: string) => {
    if (n === "organizationId") return orgId; if (n === "date") return "2026-01-05"; const id = randomUUID(); ids.push(id); return id; });
  const withHead = (ms: string[]) => [...new Set([...ms, ...(ms.includes("GET") ? ["HEAD"] : [])])];
  const bodyFor = (m: string) => (m === "GET" || m === "HEAD" || m === "DELETE" ? undefined : {});
  const unmatched = (x: { status: number; json: boolean }) => x.status === 404 && !x.json;
  const variantsOf = (r: R, orgId: string) => { const ids = [orgId]; return pathVariants(fill(r.path, orgId, ids), ids); };
  const byVariant = (leaks: string[]) => Object.entries(leaks.reduce((a: Record<string, number>, l) => { const k = l.split(" | ")[1]; a[k] = (a[k] ?? 0) + 1; return a; }, {}));

  // G1. Funcionalidades apagadas (agencia A).
  const featureCases = orgRoutes.flatMap((r) => withHead(r.methods).map((m) => ({ r, m }))).filter(({ r, m }) => { const g = gatedFeatureFor(fill(r.path, A, []), m); return g && !g.readOnlyPass; });
  const leaks1: string[] = [];
  for (const { r, m } of featureCases) for (const v of variantsOf(r, A)) {
    const res = await raw(m, v.path, tA, bodyFor(m));
    // 172: las funcionalidades de hogar (/residential/…) ni siquiera existen en una agencia: las cierra antes residentialGate
    // (403 MODALITY_NOT_AVAILABLE). Con el interruptor apagado en un hogar, verifyResidentialSchedule172 (G1–G3) exige el 404.
    const residentialOnly = /\/residential(\/|$)/i.test(decodeURIComponent(v.path));
    const closedByModality = residentialOnly && res.status === 403 && (m === "HEAD" || res.body.error === "MODALITY_NOT_AVAILABLE");
    const ok = closedByModality || (m === "HEAD" ? res.status === 404 : (res.status === 404 && res.body.error === "FEATURE_NOT_ENABLED") || unmatched(res));
    if (!ok) leaks1.push(`${m} | ${v.name} | ${v.path} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("G1. orgFeatureGate: ninguna variante ni método llega a una funcionalidad apagada (404 FEATURE_NOT_ENABLED o sin ruta)", leaks1.length === 0 && featureCases.length > 100,
    { casos: featureCases.length, fugas: leaks1.length, porVariante: byVariant(leaks1), ejemplos: leaks1.slice(0, 6) });

  // G2. Rutas de equipo en un independiente.
  const teamCases = orgRoutes.flatMap((r) => withHead(r.methods).map((m) => ({ r, m }))).filter(({ r, m }) => teamRouteFor(fill(r.path, I, []), m));
  const leaks2: string[] = [];
  for (const { r, m } of teamCases) for (const v of variantsOf(r, I)) {
    const res = await raw(m, v.path, tI, bodyFor(m));
    const ok = m === "HEAD" ? res.status === 403 || res.status === 404 : (res.status === 403 && res.body.error === "MODALITY_NOT_AVAILABLE") || unmatched(res);
    if (!ok) leaks2.push(`${m} | ${v.name} | ${v.path} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("G2. modalityGate: ninguna variante ni método de una ruta de equipo llega a la ruta en un independiente", leaks2.length === 0 && teamCases.length > 20,
    { casos: teamCases.length, fugas: leaks2.length, porVariante: byVariant(leaks2), ejemplos: leaks2.slice(0, 6) });

  // G3. Contrato pendiente con «restringir operación nueva» (agencia B).
  const NEW_OPS = /^\/organizations\/[^/]+\/(shifts|establishments\/[^/]+\/shifts|care-recipients|establishments|establishments\/[^/]+\/residents|workers|access-invitations|team\/invitations|smartmatch\/opportunities|smartmatch\/opportunities\/[^/]+\/publish|billing\/invoices|billing\/invoices\/[^/]+\/issue)$/;
  const contractCases = orgRoutes.filter((r) => r.methods.includes("POST") && NEW_OPS.test(fill(r.path, B, [])));
  const leaks3: string[] = [];
  for (const r of contractCases) for (const v of variantsOf(r, B)) {
    const res = await raw("POST", v.path, tB, {});
    if (!((res.status === 403 && res.body.error === "CONTRACT_ACCEPTANCE_REQUIRED") || unmatched(res))) leaks3.push(`POST | ${v.name} | ${v.path} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("G3. contractEnforcementGate: ninguna variante abre operación nueva con el contrato pendiente (403 CONTRACT_ACCEPTANCE_REQUIRED o sin ruta)", leaks3.length === 0 && contractCases.length >= 10,
    { casos: contractCases.length, fugas: leaks3.length, porVariante: byVariant(leaks3), ejemplos: leaks3.slice(0, 6) });
  const contractRead = await raw("GET", `/organizations/${B}/care-recipients/`, tB);
  const contractOwn = orgRoutes.filter((r) => r.path.startsWith("/organizations/:organizationId/contracts") && r.methods.includes("POST")).map((r) => fill(r.path, B, []));
  const ownRes = await Promise.all(contractOwn.map((p) => raw("POST", p.toUpperCase().replace(B.toUpperCase(), B) + "/", tB, {})));
  const otherWrite = await raw("POST", `/organizations/${B}/care-recipients/${randomUUID()}/notes`, tB, {});
  check("G3b. Sin cambio de reglas: lecturas y el propio proceso de contrato (también en variantes) no los cierra la guarda; otras escrituras tampoco",
    contractRead.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED" && ownRes.every((x) => x.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED") && otherWrite.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED",
    [contractRead.status, ownRes.map((x) => `${x.status}:${x.body.error ?? ""}`), otherWrite.status]);

  // G4. Límite de escrituras: 120 por minuto y sesión, también en mayúsculas.
  resetFeatureWriteLimitForTests();
  const g4: number[] = [];
  for (let i = 0; i < 121; i++) g4.push((await send("POST", `/organizations/${B}/SMARTMATCH/OPPORTUNITIES/`, tB, {})).status);
  resetFeatureWriteLimitForTests();
  check("G4. El límite de escrituras (L4) cuenta las variantes en mayúsculas: la petición 121 recibe 429", g4[120] === 429 && g4.slice(0, 120).every((s) => s !== 429), g4.slice(-3));

  // G5. Sin regresión: con todo encendido (B), ninguna variante recibe FEATURE_NOT_ENABLED.
  const regress: string[] = [];
  for (const { r, m } of featureCases) for (const v of variantsOf(r, B)) {
    const res = await raw(m, v.path, tB, bodyFor(m));
    if (res.body.error === "FEATURE_NOT_ENABLED") regress.push(`${m} | ${v.name} | ${v.path}`);
  }
  check("G5. Sin regresión: con las funcionalidades encendidas ninguna variante queda cerrada por la guarda", regress.length === 0, regress.slice(0, 10));
  const agencyTeam = await raw("GET", `/organizations/${A}/team/`, tA);
  check("G5b. Sin regresión: una agencia sigue usando sus rutas de equipo (también con barra final)", agencyTeam.body.error !== "MODALITY_NOT_AVAILABLE" && agencyTeam.status < 500, agencyTeam);

  // G6. Cierre ante fallos.
  const inject = async (doSql: string, undoSql: string, fn: () => Promise<void>) => { await q(doSql); try { await fn(); } finally { await q(undoSql); } };
  let f1: Json = {}, f2: Json = {}, f3: Json[] = [], f4: Json = {};
  await inject(`ALTER FUNCTION public.app_org_feature_enabled(uuid, text) RENAME TO app_org_feature_enabled_x`, `ALTER FUNCTION public.app_org_feature_enabled_x(uuid, text) RENAME TO app_org_feature_enabled`,
    async () => { f1 = await raw("GET", `/organizations/${A}/smartmatch/opportunities`, tA); });
  await inject(`ALTER FUNCTION public.app_org_is_independent(uuid) RENAME TO app_org_is_independent_x`, `ALTER FUNCTION public.app_org_is_independent_x(uuid) RENAME TO app_org_is_independent`,
    async () => { f2 = await raw("GET", `/organizations/${I}/team`, tI); });
  await inject(`REVOKE SELECT ON sessions FROM app_runtime`, `GRANT SELECT ON sessions TO app_runtime`, async () => {
    f3 = [await raw("GET", `/organizations/${A}/finance/services`, tA), await raw("GET", `/organizations/${I}/team`, tI), await raw("POST", `/organizations/${B}/care-recipients`, tB, {})]; });
  await inject(`ALTER FUNCTION public.app_contract_enforcement_state(uuid) RENAME TO app_contract_enforcement_state_x`, `ALTER FUNCTION public.app_contract_enforcement_state_x(uuid) RENAME TO app_contract_enforcement_state`,
    async () => { f4 = await raw("POST", `/organizations/${B}/care-recipients`, tB, { firstName: "Ficticia", lastName: "Prueba" }); });
  check("G6.1 orgFeatureGate: sin la función de interruptores → 503 FEATURE_CHECK_UNAVAILABLE", f1.status === 503 && f1.body.error === "FEATURE_CHECK_UNAVAILABLE", f1);
  check("G6.2 modalityGate: sin la función de modalidad → 503 MODALITY_CHECK_UNAVAILABLE", f2.status === 503 && f2.body.error === "MODALITY_CHECK_UNAVAILABLE", f2);
  check("G6.3 Fallo inesperado al validar la sesión → 503 en las tres guardas (nunca continúa)",
    f3[0].status === 503 && ["FEATURE_CHECK_UNAVAILABLE", "MODALITY_CHECK_UNAVAILABLE"].includes(f3[0].body.error) /* 170: /finance también la cierra antes la guarda de hogares */ && f3[1].status === 503 && f3[1].body.error === "MODALITY_CHECK_UNAVAILABLE" && f3[2].status === 503 && f3[2].body.error === "CONTRACT_CHECK_UNAVAILABLE", f3);
  const created = Number((await q<{ n: number }>(`SELECT count(*)::int n FROM care_recipients WHERE organization_id=$1`, [B])).rows[0].n);
  check("G6.4 contractEnforcementGate: si el estado contractual no se puede leer → 503 CONTRACT_CHECK_UNAVAILABLE y no se crea nada", f4.status === 503 && f4.body.error === "CONTRACT_CHECK_UNAVAILABLE" && created === 0, [f4, created]);
  const bad = await raw("GET", `/organizations/${A}/smartmatch/opportunities`, "token-inexistente"), noTok = await raw("GET", `/organizations/${I}/team`, "");
  const outsider = await raw("GET", `/organizations/${B}/smartmatch/opportunities/`, tA), outsiderTeam = await raw("GET", `/organizations/%${I.charCodeAt(0).toString(16)}${I.slice(1)}/team`, tA);
  check("G6.5 Sesión inválida o sin token → 401 de la ruta; no miembro (también con variantes) → 403 ORGANIZATION_ACCESS_DENIED",
    bad.status === 401 && noTok.status === 401 && outsider.status === 403 && outsider.body.error === "ORGANIZATION_ACCESS_DENIED" && outsiderTeam.status === 403 && outsiderTeam.body.error === "ORGANIZATION_ACCESS_DENIED", [bad.status, noTok.status, outsider, outsiderTeam]);

  // ---- G7: estado contractual vacío, incompleto o inválido ---------------------------------------------------
  const D = await org(`Agencia estado roto ${tag}`, "HOME_CARE_AGENCY");
  const adminD = await user("admin-d"); await member(adminD, D, ["ORGANIZATION_ADMIN"]); const tD = await login(adminD, D);
  const broken: Array<[string, string]> = [
    ["sin fila", `INSERT INTO zz_contract_stub (org, present) VALUES ('${D}', false)`],
    ["modo desconocido", `INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ('${D}', 'bloqueo_total', now() - interval '1 day', false)`],
    ["modo nulo", `INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ('${D}', NULL, now() - interval '1 day', false)`],
    ["satisfecho nulo", `INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ('${D}', 'restrict_new_operations', now() - interval '1 day', NULL)`],
    ["modo restrictivo sin fecha", `INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ('${D}', 'contract_only', NULL, false)`],
  ];
  const g7: string[] = [];
  for (const [label, insert] of broken) {
    await q(`DELETE FROM zz_contract_stub WHERE org = $1`, [D]); await q(insert);
    const before = Number((await q<{ n: number }>(`SELECT count(*)::int n FROM care_recipients WHERE organization_id=$1`, [D])).rows[0].n);
    const w = await raw("POST", `/organizations/${D}/care-recipients`, tD, { firstName: "Ficticia", lastName: "Estado" });
    const r = await raw("GET", `/organizations/${D}/care-recipients`, tD);
    const after = Number((await q<{ n: number }>(`SELECT count(*)::int n FROM care_recipients WHERE organization_id=$1`, [D])).rows[0].n);
    if (!(w.status === 503 && w.body.error === "CONTRACT_CHECK_UNAVAILABLE" && r.status === 503 && after === before)) g7.push(`${label}: POST ${w.status} ${w.body.error ?? ""} GET ${r.status} creados ${after - before}`);
  }
  await q(`DELETE FROM zz_contract_stub WHERE org = $1`, [D]);
  const offWrite = await raw("POST", `/organizations/${D}/care-recipients`, tD, { firstName: "Ficticia", lastName: "Off" });
  check("G7. Estado contractual vacío, incompleto o inválido → 503 CONTRACT_CHECK_UNAVAILABLE y no se crea nada (lecturas incluidas)", g7.length === 0, g7);
  check("G7b. Sin modo fijado («off», la situación normal hoy) la agencia opera como siempre", offWrite.status === 201, offWrite);

  // ---- G8: accesos legítimos ---------------------------------------------------------------------------------
  const C = await org(`Agencia nueva solo contrato ${tag}`, "HOME_CARE_AGENCY");
  await q(`INSERT INTO zz_contract_stub (org, mode, enforce_from, satisfied) VALUES ($1, 'contract_only', now() - interval '1 day', false)`, [C]);
  const supB = await user("sup-b"); await member(supB, B, ["SUPERVISOR"]);
  const wB = await user("worker-b"); await member(wB, B, ["WORKER"]);
  const fB = await user("family-b"); await member(fB, B, ["FAMILY"]);
  const adminC = await user("admin-c"); await member(adminC, C, ["ORGANIZATION_ADMIN"]);
  const wC = await user("worker-c"); await member(wC, C, ["WORKER"]);
  const fC = await user("family-c"); await member(fC, C, ["FAMILY"]);
  const [tSB, tWB, tFB, tC, tWC, tFC] = [await login(supB, B), await login(wB, B), await login(fB, B), await login(adminC, C), await login(wC, C), await login(fC, C)];
  const gateBlock = (x: { status: number; body: Json }) => ["CONTRACT_ACCEPTANCE_REQUIRED", "FEATURE_NOT_ENABLED", "MODALITY_NOT_AVAILABLE", "FEATURE_CHECK_UNAVAILABLE", "MODALITY_CHECK_UNAVAILABLE", "CONTRACT_CHECK_UNAVAILABLE"].includes(x.body.error);
  const contractBlock = (x: { body: Json }) => x.body.error === "CONTRACT_ACCEPTANCE_REQUIRED" || x.body.error === "CONTRACT_CHECK_UNAVAILABLE";
  const getRoutes = orgRoutes.filter((r) => r.methods.includes("GET"));
  const postRoutes = orgRoutes.filter((r) => r.methods.includes("POST"));
  const isContractRoute = (p: string) => p.startsWith("/organizations/:organizationId/contracts");
  const bad8: string[] = [];
  // a) Lecturas GET y HEAD (canónica y con barra final) de administración, supervisora, cuidador y familiar en ambos modos.
  for (const [who, t, o] of [["admin B (restringir)", tB, B], ["supervisora B", tSB, B], ["cuidador B", tWB, B], ["familiar B", tFB, B], ["admin C (solo contrato)", tC, C], ["cuidador C", tWC, C], ["familiar C", tFC, C]] as const)
    for (const r of getRoutes) { const p = fill(r.path, o, []); for (const v of [p, p + "/"]) {
      const g = await raw("GET", v, t); const h = await raw("HEAD", v, t);
      if (contractBlock(g)) bad8.push(`${who} GET ${v} → ${g.body.error}`);
      if (h.status !== g.status) bad8.push(`${who} HEAD ${v} → ${h.status} (GET ${g.status})`);
    } }
  // b) Escrituras de cuidadores y familiares: el contrato nunca las bloquea, en ningún modo.
  for (const [who, t, o] of [["cuidador B", tWB, B], ["familiar B", tFB, B], ["cuidador C", tWC, C], ["familiar C", tFC, C]] as const)
    for (const r of postRoutes) { const v = fill(r.path, o, []); const x = await raw("POST", v, t, {}); if (contractBlock(x)) bad8.push(`${who} POST ${v} → ${x.body.error}`); }
  // c) Restringir operación nueva (B): la administración y la supervisora escriben fuera de operación nueva.
  for (const [who, t] of [["admin B", tB], ["supervisora B", tSB]] as const)
    for (const r of postRoutes.filter((x) => !NEW_OPS.test(fill(x.path, B, [])))) { const v = fill(r.path, B, []); const x = await raw("POST", v, t, {}); if (contractBlock(x)) bad8.push(`${who} POST ${v} → ${x.body.error}`); }
  // d) Solo contrato (C): el propio proceso contractual sigue abierto; cualquier otra escritura de la administración se cierra (regla de siempre).
  const cOwn = await Promise.all(postRoutes.filter((r) => isContractRoute(r.path)).map((r) => raw("POST", fill(r.path, C, []) + "/", tC, {})));
  if (cOwn.some(contractBlock)) bad8.push(`admin C contratos: ${cOwn.map((x) => x.body.error ?? x.status).join(",")}`);
  const cOther = await raw("POST", `/organizations/${C}/care-recipients/`, tC, { firstName: "X", lastName: "Y" });
  const bNew = await raw("POST", `/organizations/${B}/CARE-RECIPIENTS`, tSB, { firstName: "X", lastName: "Y" });
  check("G8.1 Contrato: GET y HEAD abiertos para todos en ambos modos; cuidadores y familiares nunca bloqueados; fuera de operación nueva la gestión escribe; el proceso contractual sigue abierto",
    bad8.length === 0, { fallos: bad8.length, ejemplos: bad8.slice(0, 10) });
  check("G8.2 Las reglas contractuales siguen aplicándose igual: «solo contrato» cierra otras escrituras de la administración y «restringir» cierra operación nueva también a la supervisora",
    cOther.body.error === "CONTRACT_ACCEPTANCE_REQUIRED" && bNew.body.error === "CONTRACT_ACCEPTANCE_REQUIRED", [cOther, bNew]);
  // e) Modalidad: un independiente usa todas sus rutas abiertas (GET/HEAD, también con barra final) y su ficha de credenciales.
  const bad8m: string[] = [];
  // 170: /residential solo existe para hogares (residentialGate la cierra a independientes por diseño).
  for (const r of getRoutes.filter((x) => !teamRouteFor(fill(x.path, I, []), "GET") && !/\/residential(\/|$)/.test(x.path))) { const p = fill(r.path, I, []); for (const v of [p, p + "/"]) {
    const g = await raw("GET", v, tI); const h = await raw("HEAD", v, tI);
    if (g.body.error === "MODALITY_NOT_AVAILABLE" || h.status !== g.status) bad8m.push(`GET/HEAD ${v} → ${g.status} ${g.body.error ?? ""} / ${h.status}`); } }
  const cred = await raw("POST", `/organizations/${I}/workers/${randomUUID()}/credentials/`, tI, {});
  const agencyTeamAll = await Promise.all(getRoutes.filter((x) => teamRouteFor(fill(x.path, A, []), "GET")).map((r) => raw("GET", fill(r.path, A, []) + "/", tA)));
  check("G8.3 Modalidad: el independiente conserva todas sus rutas abiertas (GET/HEAD) y su ficha de credenciales; las agencias conservan sus rutas de equipo",
    bad8m.length === 0 && cred.body.error !== "MODALITY_NOT_AVAILABLE" && agencyTeamAll.every((x) => x.body.error !== "MODALITY_NOT_AVAILABLE"), { fallos: bad8m.slice(0, 8), cred: cred.status });
  // f) Funcionalidades encendidas (B): cuidador y familiar no reciben FEATURE_NOT_ENABLED en GET/HEAD de rutas de funcionalidad.
  const bad8f: string[] = [];
  for (const [who, t] of [["cuidador B", tWB], ["familiar B", tFB]] as const)
    // 170/172: /residential solo existe para hogares (B es una agencia), como en G8.3.
    for (const r of getRoutes.filter((x) => gatedFeatureFor(fill(x.path, B, []), "GET") && !/\/residential(\/|$)/.test(x.path))) { const p = fill(r.path, B, []); for (const v of [p, p + "/"]) {
      const g = await raw("GET", v, t); const h = await raw("HEAD", v, t);
      if (g.body.error === "FEATURE_NOT_ENABLED" || gateBlock(g) && g.body.error !== "CONTRACT_ACCEPTANCE_REQUIRED" || h.status !== g.status) bad8f.push(`${who} ${v} → ${g.status} ${g.body.error ?? ""} / HEAD ${h.status}`); } }
  check("G8.4 Funcionalidades encendidas: cuidadores y familiares no quedan cerrados por la guarda (GET y HEAD, también con barra final)", bad8f.length === 0, bad8f.slice(0, 8));

  check("Z. Ninguna respuesta 500 en toda la prueba", errors500.length === 0, errors500.slice(0, 15));

  server.close(); await pool.end(); await db.end();
  await srv.query(`DROP DATABASE ${name} WITH (FORCE)`); await srv.end();
  delete process.env.CONTRACTS_ENFORCEMENT;
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

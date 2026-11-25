/**
 * 170 · Hogares F0 — revisión independiente del 25-nov-2026 (A1, A2, A3). Datos FICTICIOS, base PROPIA desechable,
 * aplicación real por HTTP como app_runtime. Ningún correo real (Resend interceptado), ninguna salida de red.
 *
 *   A1. Todas las rutas residenciales y denegadas, con TODAS sus variantes que Express acepta (barra final, dobles
 *       barras, mayúsculas en literales y en ids, ids codificados en %XX, literales codificados) y todos sus métodos
 *       (más HEAD para los GET): en un hogar ninguna variante llega a la ruta; en agencias e independientes nada cambia.
 *       Las peticiones se envían con node:http sin normalizar la ruta (fetch resolvería las rutas antes de enviarlas).
 *   A2. Cierre ante fallos: errores inesperados al validar la sesión, al comprobar la pertenencia o al consultar la
 *       modalidad → 503 MODALITY_CHECK_UNAVAILABLE (nunca se continúa); sesión inválida → 401 de la ruta;
 *       no miembro → 403 ORGANIZATION_ACCESS_DENIED (sin revelar el tipo).
 *   A3. app_org_is_residential no revela el tipo de una organización que la sesión no podría leer.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
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
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(-1200) });

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

/** Variantes de una ruta concreta que Express 5 (router 2, path-to-regexp 8: sin distinguir mayúsculas, barra final opcional) puede aceptar. */
export function pathVariants(path: string, ids: string[]): Array<{ name: string; path: string }> {
  const enc = (s: string, i = 0) => s.slice(0, i) + "%" + s.charCodeAt(i).toString(16).toUpperCase() + s.slice(i + 1);
  const segs = path.split("/");
  const isId = (s: string) => ids.includes(s);
  const out: Array<{ name: string; path: string }> = [
    { name: "canónica", path },
    { name: "barra final", path: path + "/" },
    { name: "doble barra final", path: path + "//" },
    { name: "literales en mayúsculas", path: segs.map((s) => (isId(s) ? s : s.toUpperCase())).join("/") },
    { name: "ids en mayúsculas", path: segs.map((s) => (isId(s) ? s.toUpperCase() : s)).join("/") },
    { name: "todo en mayúsculas + barra final", path: path.toUpperCase() + "/" },
    { name: "id de organización codificado (%XX)", path: segs.map((s, i) => (i === 2 ? enc(s) : s)).join("/") },
    { name: "id de organización totalmente codificado", path: segs.map((s, i) => (i === 2 ? [...s].map((c) => "%" + c.charCodeAt(0).toString(16)).join("") : s)).join("/") },
    { name: "doble barra tras la organización", path: segs.slice(0, 3).join("/") + "/" + segs.slice(3).join("/").replace(/^/, "/") },
  ];
  const lastLiteral = segs.map((s, i) => [s, i] as const).filter(([s, i]) => i > 2 && s && !isId(s) && !/^\d{4}-/.test(s)).pop();
  if (lastLiteral) out.push({ name: "literal codificado (%XX)", path: segs.map((s, i) => (i === lastLiteral[1] ? enc(s) : s)).join("/") });
  const innerId = segs.findIndex((s, i) => i > 2 && isId(s));
  if (innerId > 0) out.push({ name: "id interno codificado", path: segs.map((s, i) => (i === innerId ? enc(s) : s)).join("/") });
  return out;
}

async function freshDb(srv: pg.Client, prefix: string) {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  await srv.query(`CREATE DATABASE ${name}`);
  const u = new URL(serverUrl!); u.pathname = `/${name}`;
  const m = new pg.Client({ connectionString: u.toString() }); await m.connect();
  const log = console.log; console.log = () => undefined;
  try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; }
  return { name, url: u.toString(), client: m };
}

async function main() {
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  const own = await freshDb(srv, "etnara_h170g");
  await own.client.end();
  const db = new pg.Client({ connectionString: own.url }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(own.url); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { residentialRouteFor } = await import("../src/middleware/residentialRules.js");
  const { pool } = await import("../src/config/db.js");
  const { resetFeatureWriteLimitForTests } = await import("../src/middleware/featureWriteLimit.js");
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const errors500: string[] = [];
  // node:http envía la ruta tal cual (sin resolver «//», «%XX» ni mayúsculas).
  // El límite de escrituras (L4) se reinicia en cada petición: aquí se prueba la guarda, no el límite.
  const raw = (method: string, path: string, token: string, body?: Json) => { resetFeatureWriteLimitForTests(); return rawSend(method, path, token, body); };
  const rawSend = (method: string, path: string, token: string, body?: Json) => new Promise<{ status: number; json: boolean; body: Json }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => (text += c)); res.on("end", () => {
        const isJson = (res.headers["content-type"] ?? "").includes("application/json");
        let parsed: Json = {}; if (isJson) { try { parsed = JSON.parse(text); } catch { /* vacío */ } }
        if (res.statusCode === 500) errors500.push(`${method} ${path} ${res.statusCode} ${parsed.error ?? ""}`);
        resolve({ status: res.statusCode ?? 0, json: isJson, body: parsed });
      });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });

  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  const org = async (name: string, type: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `h170g-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (x: { email: string }, o?: string) => {
    const t = (await raw("POST", "/auth/login", "", { email: x.email, password })).body.token as string;
    if (o) await raw("POST", "/me/active-organization", t, { organizationId: o }); return t; };

  const A = await org(`Agencia Ficticia ${tag}`, "HOME_CARE_AGENCY"), H = await org(`Hogar Ficticio ${tag}`, "RESIDENTIAL_CARE_HOME"), H2 = await org(`Otro Hogar ${tag}`, "RESIDENTIAL_CARE_HOME");
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','verificador local','Prueba local con datos ficticios (163: candado)',5)`);
  await q(`UPDATE platform_modalities SET enabled=true WHERE code='INDEPENDENT_PROVIDER'`);
  const I = await org(`Independiente Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  await q(`UPDATE platform_modalities SET enabled=false WHERE code='INDEPENDENT_PROVIDER'`);
  const adminA = await user("admin-agencia"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const adminH = await user("admin-hogar"); await member(adminH, H, ["ORGANIZATION_ADMIN"]);
  const adminI = await user("independiente"); await member(adminI, I, ["ORGANIZATION_ADMIN"]);
  const central = await user("central"); await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tA = await login(adminA, A), tH = await login(adminH, H), tI = await login(adminI, I);

  // ---- A1: inventario de rutas -----------------------------------------------------------------------------
  type R = { methods: string[]; path: string };
  const routes: R[] = [];
  const walk = (stack: any[]) => { for (const l of stack) { if (l.route) routes.push({ methods: Object.keys(l.route.methods).map((m) => m.toUpperCase()), path: l.route.path }); else if (l.handle?.stack) walk(l.handle.stack); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  walk((app as any).router.stack); // eslint-disable-line @typescript-eslint/no-explicit-any
  const fill = (p: string, orgId: string, ids: string[]) => p.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    if (name === "organizationId") return orgId;
    if (name === "date") return "2026-01-05";
    const id = randomUUID(); ids.push(id); return id; });
  const gated = routes.filter((r) => residentialRouteFor(fill(r.path, H, [])));
  const keywords = /\/(residential|finance|billing|smartmatch|shift-reports?|shift-report-|private-instructions)(\/|$)/i;
  const uncovered = routes.filter((r) => r.path.startsWith("/organizations/:organizationId/") && keywords.test(r.path) && !residentialRouteFor(fill(r.path, H, [])));
  check("A1.1 Cobertura: toda ruta de organización de Finanzas, Facturación, SmartMatch, Informe de Turno y /residential está cubierta por una regla",
    uncovered.length === 0 && gated.length >= 80, { gated: gated.length, uncovered: uncovered.map((r) => r.path) });

  const variantsFor = (r: R, orgId: string) => { const ids = [orgId]; const p = fill(r.path, orgId, ids); return pathVariants(p, ids); };
  const methodsFor = (r: R) => [...new Set([...r.methods, ...(r.methods.includes("GET") ? ["HEAD"] : [])])];
  const bodyFor = (m: string) => (m === "GET" || m === "HEAD" || m === "DELETE" ? undefined : {});
  const blocked = (x: { status: number; body: Json }) => x.status === 403 && x.body.error === "MODALITY_NOT_AVAILABLE";
  const unmatched = (x: { status: number; json: boolean }) => x.status === 404 && !x.json; // Express sin ruta: 404 HTML
  const isDenied = (r: R) => residentialRouteFor(fill(r.path, H, []))?.kind === "denied";

  // Hogar en rutas denegadas: cada variante y método o la cierra la guarda, o Express no la reconoce.
  const leaksH: string[] = []; let triesH = 0;
  for (const r of gated.filter(isDenied)) for (const v of variantsFor(r, H)) for (const m of methodsFor(r)) {
    triesH++;
    const res = await raw(m, v.path, tH, bodyFor(m));
    const ok = m === "HEAD" ? res.status === 403 || res.status === 404 : blocked(res) || unmatched(res);
    if (!ok) leaksH.push(`${m} ${v.name} ${v.path} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("A1.2 Hogar: ninguna variante ni método de una ruta denegada llega a la ruta (403 MODALITY_NOT_AVAILABLE o sin ruta en Express)", leaksH.length === 0, { intentos: triesH, fugas: leaksH.filter((l) => l.includes(" canónica ") || l.includes(" barra final ")).slice(0, 12), total: leaksH.length, porVariante: Object.entries(leaksH.reduce((a: Record<string, number>, l) => { const k = l.split(" ").slice(1, -4).join(" "); a[k] = (a[k] ?? 0) + 1; return a; }, {})) });

  // Agencia e independiente en /residential: lo mismo.
  const leaksR: string[] = []; let triesR = 0;
  for (const [t, o] of [[tA, A], [tI, I]] as const) for (const r of gated.filter((x) => !isDenied(x))) for (const v of variantsFor(r, o)) for (const m of methodsFor(r)) {
    triesR++;
    const res = await raw(m, v.path, t, bodyFor(m));
    const ok = m === "HEAD" ? res.status === 403 || res.status === 404 : blocked(res) || unmatched(res);
    if (!ok) leaksR.push(`${o === A ? "agencia" : "independiente"} ${m} ${v.name} ${v.path} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("A1.3 Agencia e independiente: ninguna variante de /residential llega a la ruta", leaksR.length === 0, { intentos: triesR, fugas: leaksR.slice(0, 25) });

  // Sin regresión: la guarda de hogares nunca cierra nada en agencias ni independientes, y el hogar llega a /residential.
  const regress: string[] = [];
  for (const [t, o] of [[tA, A], [tI, I]] as const) for (const r of gated.filter(isDenied)) for (const v of variantsFor(r, o)) {
    const m = r.methods[0];
    const res = await raw(m, v.path, t, bodyFor(m));
    if (blocked(res) && !(o === I && res.body.error === "MODALITY_NOT_AVAILABLE" && (await raw(m, fill(r.path, I, []), t, bodyFor(m))).body.error === "MODALITY_NOT_AVAILABLE")) regress.push(`${o === A ? "agencia" : "independiente"} ${m} ${v.path}`);
  }
  check("A1.4 Sin regresión: en agencias e independientes la guarda de hogares no cierra ninguna variante (lo que ya cerraba la 160 sigue igual)", regress.length === 0, regress.slice(0, 20));
  const homeOk: string[] = [];
  for (const v of pathVariants(`/organizations/${H}/residential/overview`, [H])) {
    const res = await raw("GET", v.path, tH);
    if (!(res.status === 200 && res.body.overview) && !unmatched(res)) homeOk.push(`${v.name} → ${res.status} ${res.body.error ?? ""}`);
  }
  check("A1.5 El hogar llega a su panel con las variantes que Express acepta (200), sin bloqueos indebidos", homeOk.length === 0, homeOk);
  const other = await raw("GET", `/organizations/${H2}/finance/services/`, tH);
  check("A1.6 Un hogar contra otro hogar (no miembro), con barra final: 403 ORGANIZATION_ACCESS_DENIED, no revela el tipo", other.status === 403 && other.body.error === "ORGANIZATION_ACCESS_DENIED", other);

  // ---- Informativo (no forma parte de F0): la misma clase de variante en las guardas ya existentes ------------
  // orgFeatureGate (108/157) y modalityGate (160) usan el mismo tipo de regla sin decodificar. Se registra para
  // decidir aparte; esta prueba no falla por ello.
  const encA = `/organizations/%${A.charCodeAt(0).toString(16)}${A.slice(1)}`, encI = `/organizations/%${I.charCodeAt(0).toString(16)}${I.slice(1)}`;
  const infoRows = [
    ["agencia sin SMARTMATCH, canónica", await raw("GET", `/organizations/${A}/smartmatch/opportunities`, tA)],
    ["agencia sin SMARTMATCH, id codificado", await raw("GET", `${encA}/smartmatch/opportunities`, tA)],
    ["independiente, ruta de equipo canónica", await raw("GET", `/organizations/${I}/team`, tI)],
    ["independiente, ruta de equipo con id codificado", await raw("GET", `${encI}/team`, tI)],
  ] as const;
  for (const [name, r] of infoRows) console.log(`INFO preexistente ${name}: ${r.status} ${r.body.error ?? ""}`);

  // ---- A2: cierre ante fallos --------------------------------------------------------------------------------
  const denied = `/organizations/${H}/finance/services`;
  const deniedA = `/organizations/${A}/finance/services`;
  const asRt = async (fn: () => Promise<void>, undo: string) => { try { await fn(); } finally { await q(undo); await pool.query("SELECT 1"); } };
  let f1: Json = {}, f1a: Json = {};
  await asRt(async () => { await q(`ALTER FUNCTION public.app_org_is_residential(uuid) RENAME TO app_org_is_residential_x`);
    f1 = await raw("GET", denied, tH); f1a = await raw("GET", deniedA, tA); }, `ALTER FUNCTION public.app_org_is_residential_x(uuid) RENAME TO app_org_is_residential`);
  check("A2.1 Sin la función (42883): el hogar NO llega a Finanzas: 503 MODALITY_CHECK_UNAVAILABLE (también la agencia: se cierra, no se abre)",
    f1.status === 503 && f1.body.error === "MODALITY_CHECK_UNAVAILABLE" && f1a.status === 503 && f1a.body.error === "MODALITY_CHECK_UNAVAILABLE", [f1, f1a]);
  let f2: Json = {};
  await asRt(async () => { await q(`REVOKE SELECT ON organization_memberships FROM app_runtime`); f2 = await raw("GET", denied, tH); }, `GRANT SELECT ON organization_memberships TO app_runtime`);
  check("A2.2 Fallo inesperado de la base (permiso retirado sobre organization_memberships): 503 MODALITY_CHECK_UNAVAILABLE de la guarda (no continúa)", f2.status === 503 && f2.body.error === "MODALITY_CHECK_UNAVAILABLE", f2);
  let f3: Json = {};
  await asRt(async () => { await q(`REVOKE SELECT ON sessions FROM app_runtime`); f3 = await raw("GET", denied, tH); }, `GRANT SELECT ON sessions TO app_runtime`);
  check("A2.3 Fallo inesperado al validar la sesión: 503 MODALITY_CHECK_UNAVAILABLE de la guarda (no continúa)", f3.status === 503 && f3.body.error === "MODALITY_CHECK_UNAVAILABLE", f3);
  const bad = await raw("GET", denied, "token-que-no-existe"), none = await raw("GET", denied, "");
  check("A2.4 Sesión inválida o ausente: la ruta responde su 401 de siempre", bad.status === 401 && none.status === 401, [bad.status, none.status]);
  await q(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [adminH.id]);
  const revoked = await raw("GET", denied, tH);
  check("A2.5 Sesión revocada: 401, nunca acceso", revoked.status === 401, revoked);
  const nonMember = await raw("GET", `/organizations/${H}/finance/services/`, tA);
  check("A2.6 No miembro: 403 ORGANIZATION_ACCESS_DENIED (no revela el tipo)", nonMember.status === 403 && nonMember.body.error === "ORGANIZATION_ACCESS_DENIED", nonMember);
  const malformed = await raw("GET", `/organizations/no-es-un-uuid/finance/services`, tA);
  check("A2.7 Identificador mal formado: la ruta responde su 400 (ninguna regla lo reconoce y no hay acceso)", malformed.status === 400, malformed);

  // ---- A3: app_org_is_residential sin oráculo entre organizaciones ------------------------------------------
  const fnRow = (await q<{ secdef: boolean; pub: boolean; rt: boolean }>(`SELECT p.prosecdef secdef, has_function_privilege('public', p.oid, 'EXECUTE') pub,
    has_function_privilege('app_runtime', p.oid, 'EXECUTE') rt FROM pg_proc p WHERE p.oid = 'public.app_org_is_residential(uuid)'::regprocedure`)).rows[0];
  const ctx = async (userId: string | null, orgId: string | null, superadmin: boolean, target: string) => {
    try { await rt.query("BEGIN");
      await rt.query(`SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true), set_config('app.is_superadmin', $3, true)`, [userId ?? "", orgId ?? "", superadmin ? "true" : "false"]);
      const r = (await rt.query<{ r: boolean }>(`SELECT app_org_is_residential($1::uuid) r`, [target])).rows[0].r; await rt.query("ROLLBACK"); return String(r);
    } catch (e) { await rt.query("ROLLBACK").catch(() => undefined); return (e as Error).message; } };
  const noCtx = await ctx(null, null, false, H), aOnH = await ctx(adminA.id, A, false, H), aOnA = await ctx(adminA.id, A, false, A), hOnH = await ctx(adminH.id, H, false, H);
  const hOnH2 = await ctx(adminH.id, H, false, H2), forgedOrg = await ctx(adminA.id, H, false, H), forgedSuper = await ctx(adminA.id, A, true, H), platform = await ctx(central.id, null, true, H);
  check("A3.1 app_runtime sin contexto no obtiene el tipo de ninguna organización (error, nunca true/false)", noCtx.includes("RESIDENTIAL_ORG_NOT_VISIBLE"), noCtx);
  check("A3.2 Miembro de una agencia no obtiene el tipo de un hogar ajeno, ni de otro hogar desde un hogar", aOnH.includes("RESIDENTIAL_ORG_NOT_VISIBLE") && hOnH2.includes("RESIDENTIAL_ORG_NOT_VISIBLE"), [aOnH, hOnH2]);
  check("A3.3 Contexto falsificado (organización ajena o superadmin sin ser de plataforma): sin respuesta", forgedOrg.includes("RESIDENTIAL_ORG_NOT_VISIBLE") && forgedSuper.includes("RESIDENTIAL_ORG_NOT_VISIBLE"), [forgedOrg, forgedSuper]);
  check("A3.4 Miembro de su organización: respuesta correcta (agencia false, hogar true); ETNARA Central (plataforma): true", aOnA === "false" && hOnH === "true" && platform === "true", [aOnA, hOnH, platform]);
  check("A3.5 La función sigue sin PUBLIC; app_runtime la ejecuta solo con el contexto anterior", fnRow?.pub === false && fnRow.rt === true, fnRow);
  const su = (await q<{ r: boolean }>(`SELECT app_org_is_residential($1::uuid) r`, [H])).rows[0].r;
  check("A3.6 Migraciones y ops (rol que ya lee todas las organizaciones): respuesta correcta", su === true);

  check("Z. Ninguna respuesta 500 en toda la prueba", errors500.length === 0, errors500.slice(0, 20));

  server.close(); await pool.end(); await rt.end(); await db.end();
  await srv.query(`DROP DATABASE ${own.name} WITH (FORCE)`); await srv.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.check}${r.pass ? "" : `\n      ${r.detail}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

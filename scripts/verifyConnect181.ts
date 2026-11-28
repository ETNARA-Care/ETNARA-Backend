/**
 * 181 · Integración real Care ↔ Connect (C-2 vínculo de cuentas + C-3 estado firmado y aviso inmediato).
 * Datos FICTICIOS, base PROPIA desechable, sin red externa (solo 127.0.0.1). App real por HTTP como app_runtime.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");
process.env.NODE_ENV = "test";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: unknown = "") => results.push({ check: name, pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;

async function main() {
  const own = `etnara_c181_${randomBytes(4).toString("hex")}`;
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

  // Connect simulado: recibe los avisos firmados. Responde 503 mientras `failing` sea verdadero.
  const inbox: string[] = []; let failing = false;
  const hook = createServer((req: IncomingMessage, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { if (failing) { res.statusCode = 503; res.end(); return; } inbox.push(b); res.statusCode = 204; res.end(); }); });
  hook.listen(0, "127.0.0.1"); await new Promise((r) => hook.once("listening", r));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const serviceToken = randomBytes(32).toString("hex");
  const on = () => {
    process.env.CONNECT_INTEGRATION = "on";
    process.env.CONNECT_SIGNING_KEY = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }) as string).toString("base64");
    process.env.CONNECT_SERVICE_TOKEN_SHA256 = createHash("sha256").update(serviceToken).digest("hex");
    process.env.CONNECT_WEBHOOK_URL = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/api/care/eventos`;
  };
  delete process.env.CONNECT_INTEGRATION;

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { verifyMessage } = await import("../src/modules/connect/connect.signing.js");
  const { runConnectOutboxTick } = await import("../src/modules/connect/connect.worker.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toLowerCase();
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text(); let json: Json = {}; try { json = JSON.parse(raw); } catch { /* texto */ }
    return { status: res.status, body: json, raw, headers: res.headers };
  }
  const org = async (name: string, type = "HOME_CARE_AGENCY") => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2::organization_type_enum,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (key: string) => { const email = `c181-${key}-${tag}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (x: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [x.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); };
  const login = async (x: { email: string }, o?: string) => { const r = await call("POST", "/auth/login", "", { email: x.email, password }); const t = r.body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const svc = (path: string, body?: Json, token = serviceToken) => call(body ? "POST" : "GET", path, token, body);
  const pem = publicKey.export({ format: "pem", type: "spki" }) as string;

  // Base desechable: habilitar la modalidad independiente por la vía de operaciones (autorización + encendido).
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Operación','Prueba ficticia 181',5)`);
  await q(`UPDATE platform_modalities SET enabled = true WHERE code = 'INDEPENDENT_PROVIDER'`);
  const A = await org(`Agencia Ficticia A ${tag}`), B = await org(`Agencia Ficticia B ${tag}`), I = await org(`Cuidadora Ficticia ${tag}`, "INDEPENDENT_PROVIDER");
  const adminA = await user("admin-a"), supA = await user("sup-a"), adminB = await user("admin-b"), adminI = await user("admin-i"), central = await user("central");
  await member(adminA, A, ["ORGANIZATION_ADMIN"]); await member(supA, A, ["SUPERVISOR"]); await member(adminB, B, ["ORGANIZATION_ADMIN"]); await member(adminI, I, ["ORGANIZATION_ADMIN"]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central.id]);
  const tA = await login(adminA, A), tSup = await login(supA, A), tB = await login(adminB, B), tI = await login(adminI, I), tC = await login(central);
  check("K00. El inicio de sesión de Care funciona igual (sin cambios en /auth)", [tA, tSup, tB, tI, tC].every((t) => typeof t === "string" && t.length > 20));

  // K01 apagada → 404 en todo
  const off = [await call("GET", `/organizations/${A}/connect`, tA), await call("POST", `/organizations/${A}/connect/link-code`, tA), await svc("/integrations/connect/status/" + randomUUID()), await call("GET", "/integrations/connect/public-key", "")];
  check("K01. Integración apagada: todas las rutas responden 404", off.every((r) => r.status === 404), off.map((r) => r.status));
  on();

  // K02 código: solo administración de ESA organización
  const cA = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  const sup = await call("POST", `/organizations/${A}/connect/link-code`, tSup);
  const cross = await call("POST", `/organizations/${A}/connect/link-code`, tB);
  const noAuth = await call("POST", `/organizations/${A}/connect/link-code`, "");
  const stored = await q<{ n: string; plain: string }>(`SELECT count(*)::text n, count(*) FILTER (WHERE code_sha256 = $1)::text plain FROM connect_link_codes WHERE organization_id=$2`, [String(cA.body.code ?? ""), A]);
  check("K02. Código de vínculo: lo emite la administración de la organización, 10 min, sin caché; supervisión, otra agencia y sin sesión no pueden; se guarda solo su huella",
    cA.status === 201 && /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(cA.body.code) && Math.abs(new Date(cA.body.expiresAt).getTime() - Date.now() - 600_000) < 15_000 && cA.headers.get("cache-control") === "no-store"
    && sup.status === 403 && cross.status === 403 && noAuth.status === 401 && stored.rows[0].n === "1" && stored.rows[0].plain === "0",
    { cA: cA.status, sup: [sup.status, sup.body], cross: [cross.status, cross.body], noAuth: noAuth.status, stored: stored.rows[0] });

  // K03 canje servidor a servidor
  const refA = randomUUID();
  const badTok = await svc("/integrations/connect/redeem", { code: cA.body.code, connectProviderRef: refA }, randomBytes(32).toString("hex"));
  const noTok = await svc("/integrations/connect/redeem", { code: cA.body.code, connectProviderRef: refA }, "");
  const red = await svc("/integrations/connect/redeem", { code: String(cA.body.code).toLowerCase().replace("-", " "), connectProviderRef: refA });
  const v = red.body.status ? verifyMessage<any>(pem, red.body.status) : null;
  const keys = v ? Object.keys(v.data ?? {}).sort().join(",") : "";
  check("K03. Canje: exige el token de servicio; devuelve el estado FIRMADO (Ed25519) verificable con la llave pública, sin datos personales",
    badTok.status === 401 && noTok.status === 401 && red.status === 200 && !!v && v.typ === "care.org.status" && v.data.organizationId === A && v.data.type === "agencia" && v.data.active === true && v.data.suspended === false && v.data.connectProviderRef === refA
    && keys === "active,connectProviderRef,contractSatisfied,organizationId,subscriptionOrder,suspended,type" && v.exp - v.iat <= 86400,
    { badTok: badTok.status, noTok: noTok.status, red: red.status, v, keys });
  const pk = await call("GET", "/integrations/connect/public-key", "");
  const tamper = red.body.status ? verifyMessage<any>(pem, ((t: string) => { const [b, g] = t.split("."); const d = JSON.parse(Buffer.from(b, "base64url").toString()); d.data.suspended = false; d.data.active = true; d.data.organizationId = B; return Buffer.from(JSON.stringify(d)).toString("base64url") + "." + g; })(red.body.status)) : "x";
  const otherKey = red.body.status ? verifyMessage<any>(generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }) as string, red.body.status) : "x";
  check("K04. La llave pública publicada coincide; una firma alterada o de otra llave se rechaza", pk.status === 200 && pk.raw.trim() === pem.trim() && tamper === null && otherKey === null, { pk: pk.status, tamper, otherKey });

  // K05 un solo uso, caducidad, duplicados
  const again = await svc("/integrations/connect/redeem", { code: cA.body.code, connectProviderRef: randomUUID() });
  const cA2 = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  const dupOrg = await svc("/integrations/connect/redeem", { code: cA2.body.code, connectProviderRef: randomUUID() });
  const cB = await call("POST", `/organizations/${B}/connect/link-code`, tB);
  const dupRef = await svc("/integrations/connect/redeem", { code: cB.body.code, connectProviderRef: refA });
  const cB2 = await call("POST", `/organizations/${B}/connect/link-code`, tB);
  await q(`UPDATE connect_link_codes SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE organization_id=$1 AND redeemed_at IS NULL`, [B]);
  const expired = await svc("/integrations/connect/redeem", { code: cB2.body.code, connectProviderRef: randomUUID() });
  const links = await q<{ n: string }>(`SELECT count(*)::text n FROM connect_links WHERE revoked_at IS NULL`);
  check("K05. Código de un solo uso y con caducidad; una organización no se vincula dos veces y una cuenta de Connect no se vincula a dos organizaciones",
    again.status === 404 && again.body.error === "CONNECT_CODE_INVALID" && dupOrg.status === 409 && dupOrg.body.error === "CONNECT_ORG_ALREADY_LINKED"
    && dupRef.status === 409 && dupRef.body.error === "CONNECT_PROVIDER_ALREADY_LINKED" && expired.status === 404 && links.rows[0].n === "1",
    { again: [again.status, again.body], dupOrg: [dupOrg.status, dupOrg.body], dupRef: [dupRef.status, dupRef.body], expired: [expired.status, expired.body], links: links.rows[0] });

  // K06 estado por referencia
  const st = await svc(`/integrations/connect/status/${refA}`);
  const unknown = await svc(`/integrations/connect/status/${randomUUID()}`);
  const stNo = await svc(`/integrations/connect/status/${refA}`, undefined, "");
  const ls = await call("GET", `/organizations/${A}/connect`, tA);
  check("K06. Estado vigente por referencia (firmado); referencia desconocida 404; sin token 401; la agencia ve «vinculada»",
    st.status === 200 && verifyMessage<any>(pem, st.body.status)?.data.active === true && unknown.status === 404 && stNo.status === 401 && ls.status === 200 && ls.body.linked === true, { st: st.status, unknown: unknown.status, stNo: stNo.status, ls: ls.body });

  // K07 independiente → tipo independiente
  const cI = await call("POST", `/organizations/${I}/connect/link-code`, tI);
  const refI = randomUUID();
  const rI = await svc("/integrations/connect/redeem", { code: cI.body.code, connectProviderRef: refI });
  check("K07. Cuidadora independiente se identifica como «independiente»", rI.status === 200 && verifyMessage<any>(pem, rI.body.status)?.data.type === "independiente", rI.body);

  // K08 aviso inmediato al suspender (sin esperar el ciclo de 30 s)
  inbox.length = 0;
  const t0 = Date.now();
  const sus = await call("PATCH", `/platform/organizations/${A}/lifecycle`, tC, { action: "suspend", reason: "Prueba ficticia de suspensión" });
  for (let i = 0; i < 40 && inbox.length === 0; i++) await sleep(50);
  const ev = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  check("K08. Suspensión en Care → Connect recibe el aviso FIRMADO al instante (< 3 s), con «suspendido» y la referencia",
    sus.status === 200 && !!ev && ev.typ === "care.org.event" && ev.data.event === "ORG_STATUS_CHANGED" && ev.data.connectProviderRef === refA && ev.data.facts.suspended === true && ev.data.facts.active === false && Date.now() - t0 < 3000,
    { sus: sus.status, ev, ms: Date.now() - t0 });
  const stS = await svc(`/integrations/connect/status/${refA}`);
  const codeSusp = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  check("K09. Organización suspendida: el estado vigente dice «suspendido» y no puede emitir códigos nuevos",
    verifyMessage<any>(pem, stS.body.status)?.data.suspended === true && codeSusp.status !== 201, { st: verifyMessage<any>(pem, stS.body.status)?.data, code: [codeSusp.status, codeSusp.body] });

  // K10 Connect caído → reintentos con espera; luego entrega
  inbox.length = 0; failing = true;
  const rea = await call("PATCH", `/platform/organizations/${A}/lifecycle`, tC, { action: "reactivate", reason: "Prueba ficticia de reactivación" });
  await sleep(600);
  const pend = await q<{ attempts: number; last_status: number; wait: boolean }>(`SELECT attempts, last_status, next_attempt_at > now() AS wait FROM connect_outbox WHERE delivered_at IS NULL ORDER BY id DESC LIMIT 1`);
  failing = false;
  await q(`UPDATE connect_outbox SET next_attempt_at = now() WHERE delivered_at IS NULL`);
  const tick = await runConnectOutboxTick();
  const ev2 = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  check("K10. Si Connect no responde, el aviso queda pendiente con espera creciente y se entrega en el siguiente intento",
    rea.status === 200 && pend.rows[0]?.attempts === 1 && pend.rows[0]?.last_status === 503 && pend.rows[0]?.wait === true && tick.delivered === 1 && ev2?.data.facts.active === true,
    { rea: rea.status, pend: pend.rows[0], tick, ev2: ev2?.data });

  // K11 organizaciones NO vinculadas no generan avisos; cambios ajenos a estado tampoco
  const before = (await q<{ n: string }>(`SELECT count(*)::text n FROM connect_outbox`)).rows[0].n;
  await call("PATCH", `/platform/organizations/${B}/lifecycle`, tC, { action: "suspend", reason: "Prueba ficticia B no vinculada" });
  await q(`UPDATE organizations SET name = name || ' ' WHERE id=$1`, [A]);
  const after = (await q<{ n: string }>(`SELECT count(*)::text n FROM connect_outbox`)).rows[0].n;
  check("K11. Solo avisa de organizaciones vinculadas y solo por cambios de estado", before === after, { before, after });

  // K12 desvincular
  inbox.length = 0;
  const unl = await call("POST", `/organizations/${A}/connect/unlink`, tA);
  for (let i = 0; i < 40 && inbox.length === 0; i++) await sleep(50);
  const ev3 = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  const stU = await svc(`/integrations/connect/status/${refA}`);
  const lsU = await call("GET", `/organizations/${A}/connect`, tA);
  const unlSup = await call("POST", `/organizations/${I}/connect/unlink`, tA);
  check("K12. Desvincular: solo la administración; Connect recibe LINK_REVOKED al instante; la referencia deja de tener estado",
    unl.status === 204 && ev3?.data.event === "LINK_REVOKED" && ev3?.data.connectProviderRef === refA && stU.status === 404 && lsU.body.linked === false && unlSup.status === 403,
    { unl: unl.status, ev3: ev3?.data, stU: stU.status, lsU: lsU.body, unlSup: unlSup.status });
  const cA3 = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  const refA2 = randomUUID();
  const reLink = await svc("/integrations/connect/redeem", { code: cA3.body.code, connectProviderRef: refA2 });
  check("K13. Tras desvincular, la organización puede volver a vincularse (sin duplicar la fila)", reLink.status === 200
    && (await q<{ n: string }>(`SELECT count(*)::text n FROM connect_links WHERE organization_id=$1`, [A])).rows[0].n === "1", [reLink.status, reLink.body]);

  // K13b C-1 · aserción para entrar en Connect (cualquier miembro activo; nunca de otra organización ni sin vínculo)
  const asr = await call("POST", `/organizations/${A}/connect/login`, tSup);
  const tokA = String(asr.body.url ?? "").split("#a=")[1] ?? "";
  const va = tokA ? verifyMessage<any>(pem, tokA) : null;
  const stSup = await call("GET", `/organizations/${A}/connect`, tSup);
  const asrCross = await call("POST", `/organizations/${A}/connect/login`, tB);
  const asrNoLink = await call("POST", `/organizations/${B}/connect/login`, tB);
  check("K13b. C-1: un miembro activo recibe una aserción FIRMADA de 2 minutos con su persona, organización y referencia; otra organización 403; organización sin vínculo (aquí suspendida) sin aserción",
    asr.status === 200 && String(asr.body.url).startsWith("http://127.0.0.1:") && String(asr.body.url).includes("/care/entrar#a=") && asr.headers.get("cache-control") === "no-store"
    && va?.typ === "care.user.assertion" && va.exp - va.iat === 120 && va.data.careUserId === supA.id && va.data.email === supA.email.toLowerCase()
    && va.data.organizationId === A && va.data.connectProviderRef === refA2 && Object.keys(va.data).length === 4
    && asrCross.status === 403 && [403, 404].includes(asrNoLink.status) && stSup.status === 200 && stSup.body.linked === true,
    { asr: [asr.status, asr.body.url ? "url" : asr.body], va, cross: [asrCross.status, asrCross.body], noLink: [asrNoLink.status, asrNoLink.body] });

  // K14 la aplicación no lee ni escribe las tablas directamente
  const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
  const deny: string[] = [];
  for (const s of ["SELECT * FROM connect_links", "SELECT * FROM connect_link_codes", "SELECT * FROM connect_outbox", `INSERT INTO connect_outbox (organization_id, event_type) VALUES ('${A}','LINK_REVOKED')`, "SELECT public.app_connect_org_facts(gen_random_uuid())"]) {
    try { await rt.query(s); deny.push("ALLOWED"); } catch (e) { deny.push((e as Error).message.slice(0, 40)); }
  }
  const noCtx = await rt.query("SELECT public.app_connect_create_link_code($1)", ["0".repeat(64)]).then(() => "ALLOWED", (e) => (e as Error).message);
  await rt.end();
  check("K14. app_runtime no puede leer ni escribir las tablas del vínculo, ni pedir hechos de otra organización, ni emitir códigos sin contexto",
    deny.every((d) => d !== "ALLOWED") && noCtx !== "ALLOWED", { deny, noCtx });

  // K15 auditoría
  const aud = await q<{ action: string; n: string }>(`SELECT action, count(*)::text n FROM audit_log WHERE action LIKE 'CONNECT_%' GROUP BY action ORDER BY action`);
  check("K15. Auditoría: emisión, vínculo y desvínculo quedan registrados", ["CONNECT_LINK_CODE_CREATED", "CONNECT_LINKED", "CONNECT_UNLINKED"].every((a) => aud.rows.some((r) => r.action === a)), aud.rows);

  // K16 reversión e idempotencia
  server.close(); hook.close(); await pool.end().catch(() => undefined);
  const rb = readFileSync(join(process.cwd(), "ops/181_connect_integration.rollback.sql"), "utf8");
  let rbOk = "ok"; try { await q(rb); } catch (e) { rbOk = (e as Error).message; }
  const gone = (await q<{ t: string | null }>(`SELECT to_regclass('public.connect_links')::text t`)).rows[0].t;
  const fwd = readFileSync(join(process.cwd(), "migrations/181_connect_integration.sql"), "utf8");
  let twice = "ok"; try { await q(fwd); await q(fwd); } catch (e) { twice = (e as Error).message; }
  check("K16. La reversión elimina solo la integración; la migración se puede aplicar de nuevo y dos veces seguidas", rbOk === "ok" && gone === null && twice === "ok", { rbOk, gone, twice });

  await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`); console.error(e); process.exit(2); });

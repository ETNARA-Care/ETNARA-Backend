/**
 * 183 · C-5: Stripe del ecosistema (modo de prueba): planes de Care y Premium con UN SOLO cobro, derechos sincronizados con Connect.
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
  const own = `etnara_c183_${randomBytes(4).toString("hex")}`;
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
  const user = async (key: string) => { const email = `c183-${key}-${tag}@example.invalid`;
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
  const { createHmac } = await import("node:crypto");
  const { setSaasFetchForTests } = await import("../src/modules/saas/saas.routes.js");
  const { saasConfig } = await import("../src/modules/saas/saas.stripe.js");
  const WH = "whsec_" + "f".repeat(32);
  const stripeCalls: { url: string; form: URLSearchParams }[] = [];
  setSaasFetchForTests((async (url: string, init: { body: string }) => {
    stripeCalls.push({ url, form: new URLSearchParams(init.body) });
    if (url.includes("/v1/subscriptions/")) return new Response(JSON.stringify({ id: "sub_x", livemode: false }), { status: 200 });
    return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", livemode: false }), { status: 200 });
  }) as unknown as typeof fetch);
  const saasOff = await call("GET", `/organizations/${A}/saas`, tA);
  check("S01. Stripe apagado: las rutas responden 404", saasOff.status === 404 && (await call("POST", "/integrations/stripe/webhook", "", {})).status === 404, saasOff.status);
  on();
  process.env.SAAS_STRIPE = "on"; process.env.STRIPE_SECRET_KEY = "sk_test_" + "a".repeat(24); process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.SAAS_RETURN_URL = "https://app.etnaracare.com/agency/settings";
  let liveThrows = false; try { saasConfig({ SAAS_STRIPE: "on", STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24), STRIPE_WEBHOOK_SECRET: WH, SAAS_RETURN_URL: "https://x.com" }); } catch { liveThrows = true; }
  check("S02. Una clave REAL de Stripe detiene el módulo (cobros reales no autorizados)", liveThrows);

  for (const [plan, price] of [["premium", "price_TestPremium01"], ["care_esencial", "price_TestEsencial01"], ["care_profesional", "price_TestProf0001"]]) {
    await q(`SELECT public.app_saas_price_set($1, $2, NULL, 'Rafa (prueba)', 'Precio ficticio de prueba')`, [plan, price]);
  }
  const refA = randomUUID();
  const cA = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  await svc("/integrations/connect/redeem", { code: cA.body.code, connectProviderRef: refA });
  const co = await call("POST", `/organizations/${A}/saas/checkout`, tA, { plan: "premium" });
  const coSup = await call("POST", `/organizations/${A}/saas/checkout`, tSup, { plan: "premium" });
  const coNoPrice = await call("POST", `/organizations/${A}/saas/checkout`, tA, { plan: "care_avanzado" });
  const f = stripeCalls[0]?.form;
  check("S03. Sesión de pago: solo administración; precio configurado; organización en los metadatos; sin precio → 409",
    co.status === 200 && co.body.url.startsWith("https://checkout.stripe.com/") && f?.get("line_items[0][price]") === "price_TestPremium01"
    && f?.get("subscription_data[metadata][organization_id]") === A && f?.get("client_reference_id") === A && coSup.status === 403
    && coNoPrice.status === 409 && coNoPrice.body.error === "SAAS_PRICE_NOT_CONFIGURED", { co: co.body, coSup: coSup.status, coNoPrice: coNoPrice.body });

  let n = 0;
  const stripeHook = async (type: string, obj: Json, live = false) => {
    const body = JSON.stringify({ id: `evt_test${String(++n).padStart(8, "0")}`, type, livemode: live, data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", WH).update(`${t}.${body}`).digest("hex")}`;
    const r = await realFetch(`${base}/integrations/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body });
    return { status: r.status, body: await r.json() as Json, raw: body, sig };
  };
  const ent = async () => (await q<{ e: Json }>(`SELECT public.app_saas_entitlement($1) AS e`, [A])).rows[0].e;
  const fin = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sub = (id: string, price: string, extra: Json = {}) => ({ id, customer: "cus_testAAAA1111", status: "active", current_period_end: fin, cancel_at_period_end: false,
    metadata: { organization_id: A }, items: { data: [{ price: { id: price } }] }, ...extra });
  const bad = await realFetch(`${base}/integrations/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" }, body: "{}" });
  inbox.length = 0;
  const done = await stripeHook("checkout.session.completed", { customer: "cus_testAAAA1111", client_reference_id: A, metadata: { organization_id: A }, subscription: "sub_testPREM0001" });
  const created = await stripeHook("customer.subscription.created", sub("sub_testPREM0001", "price_TestPremium01"));
  for (let i = 0; i < 40 && inbox.length === 0; i++) await sleep(50);
  const ev = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  const again = await realFetch(`${base}/integrations/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": created.sig }, body: created.raw });
  const e1 = await ent();
  check("S04. Webhook: firma exigida; cliente registrado; Premium activo; Connect recibe al instante premium=true firmado; el mismo evento no se aplica dos veces",
    bad.status === 401 && done.body.result === "applied" && created.body.result === "applied" && e1.premium === true && e1.plan === "premium"
    && ev?.data.facts.premium === true && ev.data.connectProviderRef === refA && (await again.json() as Json).result === "duplicate",
    { bad: bad.status, done: done.body, created: created.body, e1, ev: ev?.data.facts });

  const second = await stripeHook("customer.subscription.created", sub("sub_testESEN0002", "price_TestEsencial01"));
  const co2 = await call("POST", `/organizations/${A}/saas/checkout`, tA, { plan: "care_esencial" });
  const nSubs = (await q<{ n: string }>(`SELECT count(*)::text n FROM saas_subscriptions WHERE organization_id = $1`, [A])).rows[0].n;
  check("S05. UN SOLO COBRO: una segunda suscripción viva no se registra (queda para revisión) y no se abre otra sesión de pago",
    second.body.result === "second_subscription" && (await ent()).plan === "premium" && co2.status === 409 && co2.body.error === "SAAS_SUBSCRIPTION_ACTIVE" && nSubs === "1",
    { second: second.body, co2: co2.body, nSubs });

  inbox.length = 0;
  const change = await stripeHook("customer.subscription.updated", sub("sub_testPREM0001", "price_TestProf0001"));
  for (let i = 0; i < 40 && inbox.length === 0; i++) await sleep(50);
  const ev2 = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  const e2 = await ent();
  check("S06. Cambio de plan en la MISMA suscripción: Premium → Profesional; Connect recibe premium=false al instante",
    change.body.result === "applied" && e2.plan === "care_profesional" && e2.premium === false && ev2?.data.facts.premium === false, { e2, ev2: ev2?.data.facts });

  const live = await stripeHook("customer.subscription.updated", sub("sub_testPREM0001", "price_TestPremium01"), true);
  const unknownPrice = await stripeHook("customer.subscription.updated", sub("sub_testPREM0001", "price_TestUnknown01"));
  check("S07. Eventos en modo real se ignoran; un precio que no es del catálogo no cambia nada",
    live.body.result === "live_ignored" && unknownPrice.body.result === "unknown_price" && (await ent()).plan === "care_profesional", { live: live.body, unknownPrice: unknownPrice.body });

  const cancelEnd = await stripeHook("customer.subscription.updated", sub("sub_testPREM0001", "price_TestProf0001", { cancel_at_period_end: true }));
  const e3 = await ent();
  const deleted = await stripeHook("customer.subscription.deleted", sub("sub_testPREM0001", "price_TestProf0001", { status: "canceled" }));
  const st = await call("GET", `/organizations/${A}/saas`, tSup);
  check("S08. Cancelar al vencer mantiene el plan hasta el fin del periodo; al terminar, sin plan; cualquier miembro ve su plan",
    cancelEnd.body.result === "applied" && e3.cancelAtPeriodEnd === true && e3.plan === "care_profesional" && deleted.body.result === "applied"
    && (await ent()).plan === null && st.status === 200 && st.body.saas.entitlement.plan === null && st.body.saas.plans.length === 4, { e3, st: st.body });

  const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
  const deny: string[] = [];
  for (const s of ["SELECT * FROM saas_subscriptions", "SELECT * FROM saas_customers", "SELECT * FROM saas_prices",
                   "SELECT public.app_saas_price_set('premium', 'price_TestHack0001', 1, 'x', 'intento desde la app')",
                   `SELECT public.app_saas_entitlement('${A}')`]) {
    try { await rt.query(s); deny.push("ALLOWED"); } catch (e) { deny.push((e as Error).message.slice(0, 40)); }
  }
  await rt.end();
  check("S09. La aplicación no lee ni cambia suscripciones, clientes ni precios directamente, ni fija precios", deny.every((d) => d !== "ALLOWED"), deny);
  // S11 · Sin cobros superpuestos al pasar de Connect a Premium
  const { runSaasPendingTick } = await import("../src/modules/saas/saas.routes.js");
  const notice = (until: string | null, ref = refA, token = serviceToken) => call("POST", "/integrations/connect/plan", token, { connectProviderRef: ref, connectPlanUntil: until });
  const en = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const nBad = await notice(en(20), randomUUID()), nNoTok = await notice(en(20), refA, ""), nFar = await notice(en(500));
  const n20 = await notice(en(20));
  stripeCalls.length = 0;
  const coTrial = await call("POST", `/organizations/${A}/saas/checkout`, tA, { plan: "premium" });
  const trialEnd = Number(stripeCalls[0]?.form.get("subscription_data[trial_end]"));
  await notice(en(1));
  const coSoon = await call("POST", `/organizations/${A}/saas/checkout`, tA, { plan: "premium" });
  check("S11. Connect pagado 20 días más: Premium nuevo empieza a cobrarse cuando termina (prueba de Stripe hasta esa fecha); con < 48 h, se espera; aviso de plan solo con token y vínculo",
    n20.status === 200 && nBad.status === 404 && nFar.status === 400 && nNoTok.status === 401 && coTrial.status === 200 && Math.abs(trialEnd * 1000 - Date.parse(en(20))) < 120_000
    && coSoon.status === 409 && coSoon.body.error === "SAAS_PREMIUM_AFTER_CONNECT", { n20: n20.body, coTrial: coTrial.body, trialEnd, coSoon: coSoon.body });

  // S12 · Con un plan de Care vivo: el cambio a Premium se PROGRAMA para cuando termina lo pagado en Connect.
  await stripeHook("customer.subscription.created", sub("sub_testESEN0003", "price_TestEsencial01", { items: { data: [{ id: "si_TestItem0003", price: { id: "price_TestEsencial01" } }] } }));
  await notice(en(15));
  const upSup = await call("POST", `/organizations/${A}/saas/premium`, tSup);
  const up = await call("POST", `/organizations/${A}/saas/premium`, tA);
  const up2 = await call("POST", `/organizations/${A}/saas/premium`, tA);
  const pend = (await q<{ n: string }>(`SELECT count(*)::text n FROM saas_pending_changes WHERE organization_id = $1 AND applied_at IS NULL`, [A])).rows[0].n;
  stripeCalls.length = 0;
  const notYet = await runSaasPendingTick();
  await q(`UPDATE saas_pending_changes SET apply_at = now() - interval '1 minute' WHERE organization_id = $1`, [A]);
  const tick = await runSaasPendingTick();
  const call0 = stripeCalls[0];
  const st2 = await call("GET", `/organizations/${A}/saas`, tA);
  check("S12. Plan de Care vivo: pasar a Premium se programa para el fin de lo pagado en Connect (una vez); al vencer se cambia el precio de la MISMA suscripción",
    upSup.status === 403 && up.status === 200 && up.body.scheduled === true && up2.status === 200 && pend === "1" && notYet.applied === 0
    && tick.applied === 1 && call0?.url === "https://api.stripe.com/v1/subscriptions/sub_testESEN0003" && call0.form.get("items[0][id]") === "si_TestItem0003"
    && call0.form.get("items[0][price]") === "price_TestPremium01" && st2.body.saas.pendingPremiumAt === null,
    { upSup: upSup.status, up: up.body, pend, notYet, tick, call0: call0 && { url: call0.url, f: Object.fromEntries(call0.form) }, st2: st2.body });
  await notice(null);
  stripeCalls.length = 0;
  await stripeHook("customer.subscription.updated", sub("sub_testESEN0003", "price_TestEsencial01", { items: { data: [{ id: "si_TestItem0003", price: { id: "price_TestEsencial01" } }] } }));
  const now2 = await call("POST", `/organizations/${A}/saas/premium`, tA);
  check("S13. Sin plan de Connect pagado, el cambio a Premium es inmediato sobre la misma suscripción (prorrateo de Stripe)",
    now2.status === 200 && now2.body.applied === true && stripeCalls[0]?.form.get("proration_behavior") === "create_prorations", { now2: now2.body });

  const hist = (await q<{ n: string }>(`SELECT count(*)::text n FROM saas_price_history`)).rows[0].n;
  check("S10. Cada precio fijado queda en el historial con persona responsable", hist === "3", hist);

  server.close(); hook.close(); await pool.end().catch(() => undefined);
  await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`); console.error(e); process.exit(2); });

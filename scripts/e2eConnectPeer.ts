/**
 * C-6 · Care REAL para las pruebas conjuntas con ETNARA Connect (las lanza el repositorio de Connect). Base PROPIA
 * desechable, datos FICTICIOS, sin red externa (solo 127.0.0.1). Integración con Connect y Stripe (modo de prueba,
 * claves ficticias) ENCENDIDAS solo en este proceso. Imprime UNA línea JSON con lo que la prueba necesita y queda en
 * marcha hasta que se cierra su entrada estándar; entonces borra la base.
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> \
 *   npx tsx scripts/e2eConnectPeer.ts <url de eventos de Connect: http://127.0.0.1:PUERTO/api/care/eventos>
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { applyPendingMigrations } from "./lib/runMigrations.js";

const serverUrl = process.env.MIGRATIONS_DATABASE_URL;
const webhook = process.argv[2] ?? "";
if (!serverUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(serverUrl)) throw new Error("Hosted database refused");
if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/care\/eventos$/.test(webhook)) throw new Error("Connect events URL must be http://127.0.0.1:<port>/api/care/eventos");
process.env.NODE_ENV = "test";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;

async function main() {
  const own = `etnara_e2e_${randomBytes(4).toString("hex")}`;
  const srv = new pg.Client({ connectionString: serverUrl }); await srv.connect();
  await srv.query(`CREATE DATABASE ${own}`);
  const u0 = new URL(serverUrl!); u0.pathname = `/${own}`; const adminUrl = u0.toString();
  { const m = new pg.Client({ connectionString: adminUrl }); await m.connect(); const log = console.log; console.log = () => undefined;
    try { await applyPendingMigrations(m, join(process.cwd(), "migrations")); } finally { console.log = log; await m.end(); } }
  const db = new pg.Client({ connectionString: adminUrl }); await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const serviceToken = randomBytes(32).toString("hex");
  const stripeWebhookSecret = "whsec_" + randomBytes(24).toString("hex");
  Object.assign(process.env, {
    CONNECT_INTEGRATION: "on",
    CONNECT_SIGNING_KEY: Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }) as string).toString("base64"),
    CONNECT_SERVICE_TOKEN_SHA256: createHash("sha256").update(serviceToken).digest("hex"),
    CONNECT_WEBHOOK_URL: webhook,
    SAAS_STRIPE: "on", STRIPE_SECRET_KEY: "sk_test_" + "e2e".repeat(8), STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    SAAS_RETURN_URL: "https://app.etnaracare.com/agency/settings",
  });

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const { startConnectWorker } = await import("../src/modules/connect/connect.worker.js");
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  // El repartidor de respaldo (cada 30 s) también corre, como en producción.
  startConnectWorker();

  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8);
  await q(`SELECT app_ops_authorize_modality_activation('INDEPENDENT_PROVIDER','Operación','Prueba conjunta ficticia',5)`);
  await q(`UPDATE platform_modalities SET enabled = true WHERE code = 'INDEPENDENT_PROVIDER'`);
  const org = async (name: string, type = "HOME_CARE_AGENCY") => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,$2::organization_type_enum,'active') RETURNING id`, [name, type])).rows[0].id;
  const user = async (email: string) => (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
  const member = async (uid: string, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [uid, o])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); };
  const login = async (email: string, o?: string) => {
    const r = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const t = ((await r.json()) as { token: string }).token;
    if (o) await realFetch(`${base}/me/active-organization`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ organizationId: o }) });
    return t;
  };
  const orgA = await org(`Agencia Conjunta A ${tag}`), orgB = await org(`Agencia Conjunta B ${tag}`);
  // La administradora de A en Care usa el MISMO correo que la dueña de Norte en Connect (la cuenta se enlaza, no se crea).
  const emailA = process.env.E2E_ADMIN_A_EMAIL ?? `admin.a.${tag}@example.invalid`;
  const adminA = await user(emailA), adminB = await user(`admin.b.${tag}@example.invalid`), central = await user(`central.${tag}@example.invalid`);
  await member(adminA, orgA, ["ORGANIZATION_ADMIN"]); await member(adminB, orgB, ["ORGANIZATION_ADMIN"]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [central]);
  const out = {
    base, port, publicKeyB64: Buffer.from(publicKey.export({ format: "pem", type: "spki" }) as string).toString("base64"), serviceToken, stripeWebhookSecret,
    orgA, orgB, adminAId: adminA, tokenA: await login(emailA, orgA), tokenB: await login(`admin.b.${tag}@example.invalid`, orgB), tokenCentral: await login(`central.${tag}@example.invalid`),
  };
  // Precios ficticios de prueba (solo el dueño del esquema los fija).
  await q(`SELECT public.app_saas_price_set('premium', 'price_E2EPremium0001', NULL, 'Prueba conjunta', 'Precio ficticio de prueba')`);
  process.stdout.write(JSON.stringify(out) + "\n");

  const stop = async () => {
    server.close(); await pool.end().catch(() => undefined); await db.end().catch(() => undefined);
    await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on("end", () => void stop()); process.stdin.resume();
  process.on("SIGTERM", () => void stop());
}
main().catch((e) => { console.error(e); process.exit(2); });

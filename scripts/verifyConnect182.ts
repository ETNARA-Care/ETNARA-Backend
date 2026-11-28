/**
 * 182 · C-4: servicios de Connect que la familia autorizó pasar a Care (sin duplicados, decisión avisada a Connect).
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
  const own = `etnara_c182_${randomBytes(4).toString("hex")}`;
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
  const user = async (key: string) => { const email = `c182-${key}-${tag}@example.invalid`;
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
  on();
  const caregiver = await user("cuidadora"); await member(caregiver, A, ["CAREGIVER"]);
  const tCg = await login(caregiver, A);
  const refA = randomUUID();
  const cA = await call("POST", `/organizations/${A}/connect/link-code`, tA);
  const red = await svc("/integrations/connect/redeem", { code: cA.body.code, connectProviderRef: refA });
  check("T00. Preparación: organización vinculada", red.status === 200, red.status);
  const fam = randomUUID();
  const payload = (n = "Familia Ficticia") => ({ familia: { nombre: n, correo: "familia.ficticia@example.invalid" }, municipio: "Bayamón",
    servicio: { servicio: "cuido_domiciliario", inicio: "2026-12-07", horario: { dias: [1, 3, 5] }, precio: { centavos: 2000, unidad: "hora" } },
    consentimiento: { version: "care-transfer-v1", en: new Date().toISOString() } });
  const send = (id: string, acuerdoId: string, familyRef = fam, p: Json = payload(), ref = refA, token = serviceToken) =>
    call("POST", "/integrations/connect/transfers", token, { id, connectProviderRef: ref, acuerdoId, familyRef, payload: p });
  const t1 = randomUUID(), ac1 = randomUUID();
  const r1 = await send(t1, ac1), r1b = await send(t1, ac1), r1c = await send(randomUUID(), ac1);
  const rUnknown = await send(randomUUID(), randomUUID(), fam, payload(), randomUUID());
  const rBad = await send(randomUUID(), randomUUID(), fam, { ...payload(), diagnostico: "no debe entrar" });
  const rNoTok = await send(randomUUID(), randomUUID(), fam, payload(), refA, "");
  const n1 = (await q<{ n: string }>(`SELECT count(*)::text n FROM connect_transfers`)).rows[0].n;
  check("T01. Recibir: idempotente (mismo envío o mismo acuerdo = duplicado); sin vínculo 404; claves fuera de lo autorizado 400; sin token 401",
    r1.body.result === "received" && r1b.body.result === "duplicate" && r1c.body.result === "duplicate" && rUnknown.status === 404
    && rBad.status === 400 && rNoTok.status === 401 && n1 === "1", { r1: r1.body, r1b: r1b.body, r1c: r1c.body, u: rUnknown.status, bad: [rBad.status, rBad.body], noTok: rNoTok.status, n1 });

  const lA = await call("GET", `/organizations/${A}/connect/transfers`, tA);
  const lCg = await call("GET", `/organizations/${A}/connect/transfers`, tCg);
  const lB = await call("GET", `/organizations/${A}/connect/transfers`, tB);
  check("T02. Bandeja: administración ve la transferencia con lo autorizado; cuidadora y otra organización no",
    lA.status === 200 && lA.body.transfers.length === 1 && lA.body.transfers[0].payload.familia.nombre === "Familia Ficticia" && lA.body.transfers[0].linkedRecipient === null
    && lCg.status === 403 && lB.status === 403, { lA: lA.body, lCg: lCg.status, lB: lB.status });

  inbox.length = 0;
  const before = Number((await q<{ n: string }>(`SELECT count(*)::text n FROM care_recipients WHERE organization_id = $1`, [A])).rows[0].n);
  const acc = await call("POST", `/organizations/${A}/connect/transfers/${t1}/decision`, tA, { decision: "accept", newRecipient: { firstName: "Persona", lastName: "Ficticia" } });
  for (let i = 0; i < 40 && inbox.length === 0; i++) await sleep(50);
  const ev = inbox[0] ? verifyMessage<any>(pem, inbox[0]) : null;
  const after = Number((await q<{ n: string }>(`SELECT count(*)::text n FROM care_recipients WHERE organization_id = $1`, [A])).rows[0].n);
  const accCg = await call("POST", `/organizations/${A}/connect/transfers/${t1}/decision`, tCg, { decision: "reject", reason: "intento ficticio" });
  check("T03. Aceptar crea UNA persona atendida y avisa a Connect al instante (firmado); la cuidadora no decide; no se decide dos veces",
    acc.status === 200 && acc.body.status === "accepted" && after === before + 1 && ev?.data.event === "TRANSFER_DECIDED" && ev.data.transfer.transferId === t1
    && ev.data.transfer.decision === "accepted" && ev.data.connectProviderRef === refA && accCg.status === 403
    && (await call("POST", `/organizations/${A}/connect/transfers/${t1}/decision`, tA, { decision: "reject", reason: "ya decidida" })).status === 409,
    { acc: acc.body, before, after, ev: ev?.data, accCg: accCg.status });

  const t2 = randomUUID();
  await send(t2, randomUUID());
  const l2 = await call("GET", `/organizations/${A}/connect/transfers`, tA);
  const pend = l2.body.transfers.find((x: Json) => x.id === t2);
  const dupNew = await call("POST", `/organizations/${A}/connect/transfers/${t2}/decision`, tA, { decision: "accept", newRecipient: { firstName: "Otra", lastName: "Persona" } });
  const useLinked = await call("POST", `/organizations/${A}/connect/transfers/${t2}/decision`, tA, { decision: "accept", recipientId: acc.body.careRecipientId });
  const after2 = Number((await q<{ n: string }>(`SELECT count(*)::text n FROM care_recipients WHERE organization_id = $1`, [A])).rows[0].n);
  check("T04. Sin clientes duplicados: la misma familia propone la persona ya enlazada; crear otra se rechaza (y no queda creada); usar la enlazada sí",
    pend?.linkedRecipient?.id === acc.body.careRecipientId && dupNew.status === 409 && dupNew.body.error === "CONNECT_RECIPIENT_ALREADY_LINKED"
    && useLinked.status === 200 && after2 === after, { pend, dupNew: [dupNew.status, dupNew.body], useLinked: useLinked.body, after2 });

  const t3 = randomUUID();
  await send(t3, randomUUID(), randomUUID());
  const w = await call("POST", "/integrations/connect/transfers/withdraw", serviceToken, { id: t3, connectProviderRef: refA });
  const row3 = (await q<{ status: string; payload: unknown }>(`SELECT status, payload FROM connect_transfers WHERE id = $1`, [t3])).rows[0];
  const decW = await call("POST", `/organizations/${A}/connect/transfers/${t3}/decision`, tA, { decision: "reject", reason: "ya retirada" });
  const wAcc = await call("POST", "/integrations/connect/transfers/withdraw", serviceToken, { id: t1, connectProviderRef: refA });
  check("T05. Retiro de la familia: se borran sus datos; ya no se puede decidir; una aceptada no se retira desde Connect",
    w.body.result === "withdrawn" && row3.status === "withdrawn" && row3.payload === null && decW.status === 409 && wAcc.status === 409, { w: w.body, row3, decW: decW.status, wAcc: wAcc.status });

  const t4 = randomUUID();
  await send(t4, randomUUID(), randomUUID());
  const noReason = await call("POST", `/organizations/${A}/connect/transfers/${t4}/decision`, tA, { decision: "reject", reason: "" });
  const rej = await call("POST", `/organizations/${A}/connect/transfers/${t4}/decision`, tA, { decision: "reject", reason: "Sin personal en ese horario" });
  const row4 = (await q<{ payload: unknown }>(`SELECT payload FROM connect_transfers WHERE id = $1`, [t4])).rows[0];
  check("T06. Rechazar exige un motivo y borra los datos de la familia", noReason.status === 400 && rej.status === 200 && row4.payload === null, { noReason: noReason.status, rej: rej.body });

  const rt = new pg.Client({ connectionString: process.env.DATABASE_URL }); await rt.connect();
  const deny: string[] = [];
  for (const s of ["SELECT * FROM connect_transfers", "SELECT * FROM connect_recipient_links", `UPDATE connect_transfers SET status = 'accepted'`]) {
    try { await rt.query(s); deny.push("ALLOWED"); } catch (e) { deny.push((e as Error).message.slice(0, 40)); }
  }
  await rt.end();
  check("T07. app_runtime no lee ni cambia las transferencias ni los enlaces directamente", deny.every((d) => d !== "ALLOWED"), deny);

  const aud = await q<{ action: string }>(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'CONNECT_TRANSFER_%' ORDER BY 1`);
  check("T08. Auditoría de recibir, aceptar, rechazar y retirar", ["CONNECT_TRANSFER_ACCEPTED", "CONNECT_TRANSFER_RECEIVED", "CONNECT_TRANSFER_REJECTED", "CONNECT_TRANSFER_WITHDRAWN"].every((a) => aud.rows.some((r) => r.action === a)), aud.rows);

  server.close(); hook.close(); await pool.end().catch(() => undefined);
  await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 900)}`}`); console.error(e); process.exit(2); });

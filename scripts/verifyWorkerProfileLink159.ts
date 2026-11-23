/**
 * 159 · una persona, un perfil de cuidador al aceptar invitaciones (caso LaCasita de Tony, 23-nov-2026).
 * Datos FICTICIOS, base PROPIA desechable, ningún correo real (Resend interceptado). App real por HTTP como app_runtime.
 * Cubre: cuenta con perfil en otra agencia, administradora que también es cuidadora, cuidadora en varias agencias,
 * ya cuidadora en la agencia, ficha provisional con credenciales, identidad, permisos administrativos intactos,
 * aislamiento entre agencias, invitaciones de familia y de cuenta nueva sin cambios, auditoría y reversión.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { randomBytes, randomUUID } from "node:crypto";
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
  if (!/^https?:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`Salida de red bloqueada en la prueba: ${url}`);
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";

async function main() {
  const own = `etnara_w159_${randomBytes(4).toString("hex")}`;
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

  const { hashPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const tag = randomUUID().slice(0, 8).toUpperCase();
  async function call(method: string, path: string, token: string, body?: Json | Buffer, headers: Record<string, string> = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await realFetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": isBuf ? "application/octet-stream" : "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? new Uint8Array(body) : JSON.stringify(body) });
    const raw = Buffer.from(await res.arrayBuffer());
    let json: Json = {}; try { json = JSON.parse(raw.toString("utf8")); } catch { /* binario */ }
    return { status: res.status, body: json, raw };
  }
  const org = async (name: string) => (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ($1,'HOME_CARE_AGENCY','active') RETURNING id`, [name])).rows[0].id;
  const user = async (key: string) => { const email = `w159-${key}-${tag.toLowerCase()}@example.invalid`;
    return { email, id: (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id }; };
  const member = async (u: { id: string }, o: string, roles: string[]) => { const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [u.id, o])).rows[0].id;
    if (roles.length) await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, o, roles]); return m; };
  const login = async (u: { email: string }, o?: string) => { const t = (await call("POST", "/auth/login", "", { email: u.email, password })).body.token as string; if (o) await call("POST", "/me/active-organization", t, { organizationId: o }); return t; };
  const rolesOf = async (u: { id: string }, o: string) => (await q<{ c: string | null }>(`SELECT string_agg(r.code, ',' ORDER BY r.code) c FROM organization_memberships om JOIN user_roles ur ON ur.organization_membership_id=om.id JOIN roles r ON r.id=ur.role_id WHERE om.user_id=$1 AND om.organization_id=$2`, [u.id, o])).rows[0].c;
  const credType = (await q<{ id: string }>(`SELECT id FROM credential_types ORDER BY code LIMIT 1`)).rows[0].id;
  const addCredential = (workerId: string) => q(`INSERT INTO credentials (worker_id, credential_type_id, issuing_entity_type, status) SELECT $1,$2,(enum_range(NULL::issuing_entity_type_enum))[1],'active'`, [workerId, credType]);
  async function inviteWorker(adminTok: string, o: string, email: string, name: string) {
    const w = await call("POST", `/organizations/${o}/workers`, adminTok, { displayName: name, internalRole: "CNA" });
    const inv = await call("POST", `/organizations/${o}/access-invitations`, adminTok, { type: "worker", email, workerMembershipId: w.body.membership?.id });
    return { membershipId: w.body.membership?.id as string, workerId: w.body.membership?.worker_id as string, token: inv.body.token as string };
  }

  const A = await org(`Casa Demo Ficticia ${tag}`), B = await org(`LaCasita Ficticia ${tag}`), X = await org(`Otra Agencia Ficticia ${tag}`);
  const adminA = await user("admin-a"); await member(adminA, A, ["ORGANIZATION_ADMIN"]);
  const tony = await user("tony"); await member(tony, B, ["ORGANIZATION_ADMIN"]);
  const nueva = await user("admin-sin-perfil"); await member(nueva, B, ["ORGANIZATION_ADMIN"]);
  const adminX = await user("admin-x"); await member(adminX, X, ["ORGANIZATION_ADMIN"]);
  const tA = await login(adminA, A), tB = await login(tony, B), tX = await login(adminX, X);

  // Tony ya es cuidadora en Casa Demo, con una credencial (perfil único).
  const ia = await inviteWorker(tA, A, tony.email, "Tony Ficticia");
  const accA = await call("POST", "/access-invitations/accept", await login(tony, A), { token: ia.token });
  await addCredential(ia.workerId);
  check("W0. Base: Tony activó su acceso de cuidadora en Casa Demo (perfil propio)", accA.status === 200, accA.body);

  // LaCasita crea una ficha NUEVA para Tony y la invita (lo ocurrido el 23-nov).
  const ib = await inviteWorker(tB, B, tony.email, "Tony (LaCasita)");
  const tTonyB = await login(tony, B);
  const accB = await call("POST", "/access-invitations/accept", tTonyB, { token: ib.token });
  const prof = (await q<{ worker_id: string; user_id: string }>(`SELECT owm.worker_id, w.user_id FROM organization_worker_memberships owm JOIN workers w ON w.id=owm.worker_id WHERE owm.id=$1`, [ib.membershipId])).rows[0];
  const placeholder = (await q<{ user_id: string | null }>(`SELECT user_id FROM workers WHERE id=$1`, [ib.workerId])).rows[0];
  check("W1. LaCasita: aceptar con la cuenta existente → 200 (antes 500)", accB.status === 200, accB);
  check("W2. La ficha de LaCasita queda unida al perfil único; la provisional no se borra y queda sin cuenta",
    prof?.worker_id === ia.workerId && prof?.user_id === tony.id && placeholder !== undefined && placeholder.user_id === null, { prof, placeholder });
  check("W3. Tony conserva ADMIN y gana WORKER en LaCasita; Casa Demo no cambia",
    (await rolesOf(tony, B)) === "ORGANIZATION_ADMIN,WORKER" && (await rolesOf(tony, A)) === "WORKER", [await rolesOf(tony, B), await rolesOf(tony, A)]);
  const audit = (await q<{ new_value: Json; organization_id: string }>(`SELECT new_value, organization_id FROM audit_log WHERE action='WORKER_PROFILE_LINKED_ON_ACCEPT' AND entity_id=$1`, [ib.membershipId])).rows;
  check("W4. La unión queda auditada en la organización que invitó (sin datos personales)", audit.length === 1 && audit[0].organization_id === B && audit[0].new_value?.workerId === ia.workerId && !JSON.stringify(audit[0].new_value).includes("@"), audit);

  // Permisos: administración intacta y portal de cuidador disponible.
  const team = await call("GET", `/organizations/${B}/team`, tTonyB), workers = await call("GET", `/organizations/${B}/workers`, tTonyB);
  const newWorker = await call("POST", `/organizations/${B}/workers`, tTonyB, { displayName: "Ficha de prueba admin", internalRole: "CNA" });
  const wp = await call("GET", `/organizations/${B}/me/worker-profile`, tTonyB), mine = await call("GET", `/organizations/${B}/me/shifts`, tTonyB);
  const me = (await call("GET", "/me", tTonyB)).body; const orgB = (me.organizations ?? []).find((o: Json) => o.id === B);
  check("W5. Permisos administrativos intactos (equipo, personal y alta 200/201) y «Mi día» disponible (perfil y turnos 200)",
    team.status === 200 && workers.status === 200 && newWorker.status === 201 && wp.status === 200 && mine.status === 200 && orgB?.roles?.includes("ORGANIZATION_ADMIN") && orgB?.roles?.includes("WORKER"),
    [team.status, workers.status, newWorker.status, wp.status, mine.status, orgB?.roles]);
  const credsB = await call("GET", `/organizations/${B}/workers/${ia.workerId}/credentials`, tB);
  const credsX = await call("GET", `/organizations/${X}/workers/${ia.workerId}/credentials`, tX);
  check("W6. LaCasita ve las credenciales del perfil único sin volver a subirlas; otra agencia sin vínculo no", credsB.status === 200 && (credsB.body.credentials ?? []).length === 1 && credsX.status >= 400, [credsB.status, credsX.status]);
  const reuse = await call("POST", "/access-invitations/accept", tTonyB, { token: ib.token });
  check("W7. La invitación no se reutiliza", reuse.status >= 400 && reuse.status < 500, reuse);

  // Ya cuidadora en la agencia.
  const ib2 = await inviteWorker(tB, B, tony.email, "Tony duplicada");
  const dup = await call("POST", "/access-invitations/accept", tTonyB, { token: ib2.token });
  check("W8. Ya es cuidadora en la agencia → 409 WORKER_ALREADY_IN_ORGANIZATION, sin cambios", dup.status === 409 && dup.body.error === "WORKER_ALREADY_IN_ORGANIZATION" && (await q(`SELECT 1 FROM organization_worker_memberships WHERE id=$1 AND worker_id=$2`, [ib2.membershipId, ib2.workerId])).rowCount === 1, dup);

  // Cuidadora nueva (cuenta creada por la activación) y segunda agencia.
  const cuidadoraEmail = `w159-cuidadora-${tag.toLowerCase()}@example.invalid`;
  const ic = await inviteWorker(tA, A, cuidadoraEmail, "Cuidadora Varias");
  const act = await call("POST", "/access-invitations/activate", "", { token: ic.token, password });
  const cuidadora = { email: cuidadoraEmail, id: (await q<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [cuidadoraEmail])).rows[0]?.id };
  check("W9. Cuenta nueva por invitación: sin cambios respecto a 046", act.status === 200 && (await rolesOf(cuidadora, A)) === "WORKER", act);
  const tC = await login(cuidadora, A);
  const ix = await inviteWorker(tX, X, cuidadoraEmail, "Cuidadora en X (con credencial)");
  await addCredential(ix.workerId);
  const conf = await call("POST", "/access-invitations/accept", tC, { token: ix.token });
  check("W10. Ficha provisional con credenciales → 409 WORKER_PROFILE_CONFLICT, sin cambios", conf.status === 409 && conf.body.error === "WORKER_PROFILE_CONFLICT" && (await rolesOf(cuidadora, X)) === null, [conf, await rolesOf(cuidadora, X)]);
  const ix2 = await inviteWorker(tX, X, cuidadoraEmail, "Cuidadora en X");
  const ok2 = await call("POST", "/access-invitations/accept", tC, { token: ix2.token });
  const orgsC = (await call("GET", "/me", tC)).body.organizations ?? [];
  check("W11. Cuidadora en varias agencias con su mismo perfil", ok2.status === 200 && orgsC.length === 2 && orgsC.every((o: Json) => (o.roles ?? []).includes("WORKER")), [ok2.status, orgsC.map((o: Json) => o.roles)]);

  // Aislamiento y límites de rol.
  const tCX = await login(cuidadora, X);
  const xA = await call("GET", `/organizations/${A}/workers`, tX), xAs = await call("GET", `/organizations/${A}/shifts`, tX);
  const cAdmin = await call("GET", `/organizations/${X}/workers`, tCX), cTeam = await call("GET", `/organizations/${X}/team`, tCX);
  const tonyX = await call("GET", `/organizations/${X}/workers`, tTonyB);
  check("W12. Aislamiento: X no ve personal ni turnos de Casa Demo; Tony no entra en X", xA.status >= 400 && xAs.status >= 400 && tonyX.status >= 400, [xA.status, xAs.status, tonyX.status]);
  check("W13. Una cuidadora (solo WORKER) no obtiene permisos administrativos al unirse", cAdmin.status === 403 && cTeam.status === 403, [cAdmin.status, cTeam.status]);

  // Identidad.
  const ib3 = await inviteWorker(tB, B, adminX.email, "Otra persona con cuenta");
  const wrong = await call("POST", "/access-invitations/accept", tTonyB, { token: ib3.token });
  check("W14. Otra cuenta no puede aceptar una invitación ajena (403 INVITATION_IDENTITY_MISMATCH)", wrong.status === 403 && wrong.body.error === "INVITATION_IDENTITY_MISMATCH", wrong);

  // Administradora sin perfil previo.
  const id2 = await inviteWorker(tB, B, nueva.email, "Administradora sin perfil");
  const accN = await call("POST", "/access-invitations/accept", await login(nueva, B), { token: id2.token });
  check("W15. Administradora sin perfil previo → ADMIN + WORKER (como en 046)", accN.status === 200 && (await rolesOf(nueva, B)) === "ORGANIZATION_ADMIN,WORKER", [accN.status, await rolesOf(nueva, B)]);

  // Familia: sin cambios.
  const rec = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id, first_name, last_name, status) VALUES ($1,'Residente','Ficticio','active') RETURNING id`, [B])).rows[0].id;
  const fam = await call("POST", `/organizations/${B}/access-invitations`, tB, { type: "family", email: adminX.email, careRecipientId: rec, relationshipType: "hija" });
  const famAcc = await call("POST", "/access-invitations/accept", tX, { token: fam.body.token });
  check("W16. Invitación de familia con cuenta existente: sin cambios (FAMILY, sin perfil de cuidador)", famAcc.status === 200 && (await rolesOf(adminX, B)) === "FAMILY" && (await q(`SELECT 1 FROM workers WHERE user_id=$1`, [adminX.id])).rowCount === 0, [fam.status, famAcc.status, await rolesOf(adminX, B)]);

  // Nunca 500 en el flujo.
  check("W17. Ningún 500 en todo el flujo de invitaciones", ![accA, accB, reuse, dup, act, conf, ok2, wrong, accN, famAcc].some((r) => r.status >= 500), "");
  check("M1. Ningún correo real", mails.every((m) => m.to.endsWith("@example.invalid")), mails.length);

  server.close(); await pool.end().catch(() => undefined); await db.end();
  await srv.query(`DROP DATABASE ${own} WITH (FORCE)`).catch(() => undefined); await srv.end();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`TOTAL ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.pass ? "" : ` — ${r.detail.slice(0, 600)}`}`); console.error(e); process.exit(2); });

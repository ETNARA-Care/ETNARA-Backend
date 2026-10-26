/**
 * End-to-end check of scripts/secureDemoAccounts.ts (disposable database only, synthetic data).
 *
 * Builds a Casa Demo-like agency with the five @demo.etnara.care accounts (random password,
 * never the published one), opens real sessions over HTTP as app_runtime, then proves:
 * guards abort without writing, the simulation writes nothing, applying locks the old password,
 * revokes sessions and reset links, keeps Casa Demo intact, writes audit rows without secrets,
 * and that the owner can take an account back through the normal "forgot password" flow.
 * Also proves the demo scripts refuse to run outside a disposable database.
 *
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { aliasFor, secureDemoAccounts } from "./secureDemoAccounts.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ check: name, pass, detail });

const mails: Array<{ to: string; html: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, html: String(body.html ?? "") });
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input as never, init);
}) as typeof fetch;
process.env.RESEND_API_KEY = "test-only-not-a-key";
process.env.ACTIVATION_BASE_URL = "https://app.example.invalid";
const linkToken = (html: string) => /\/reset-password\?token=([0-9a-f]{64})/.exec(html)?.[1] ?? null;

async function main() {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
  const runtimePassword = randomBytes(24).toString("hex");
  await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = runtimePassword;
  process.env.DATABASE_URL = u.toString();
  const { hashPassword, verifyPassword } = await import("../src/security/password.js");
  const { createApp } = await import("../src/app.js");
  const { pool } = await import("../src/config/db.js");
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ip = 10;
  async function call(method: string, path: string, token: string, body?: Json) {
    const res = await realFetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${ip}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let parsed: Json = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed, text };
  }

  // The five demo accounts must not exist yet in this database.
  const pre = (await q(`SELECT count(*)::int n FROM users WHERE lower(email) LIKE '%@demo.etnara.care'`)).rows[0].n;
  if (pre !== 0) throw new Error("Use a fresh database: @demo.etnara.care accounts already exist");

  const password = randomBytes(18).toString("hex");
  const hash = await hashPassword(password);
  const org = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ('Casa Demo (prueba)','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id;
  const other = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ('Otra agencia (prueba)','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id;
  const people: Record<string, { id: string; email: string; m: string; owm?: string }> = {};
  for (const [key, roles, worker] of [["admin", ["ORGANIZATION_ADMIN"], false], ["supervisor", ["SUPERVISOR"], false], ["maria", ["WORKER"], true], ["carlos", ["WORKER"], true], ["familia", ["FAMILY"], false]] as const) {
    const email = `${key}@demo.etnara.care`;
    const id = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, hash])).rows[0].id;
    const m = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [id, org])).rows[0].id;
    await q(`INSERT INTO user_roles (organization_membership_id,organization_id,role_id) SELECT $1,$2,id FROM roles WHERE code = ANY($3)`, [m, org, roles]);
    let owm: string | undefined;
    if (worker) {
      const w = (await q<{ id: string }>(`INSERT INTO workers (user_id,display_name) VALUES ($1,$2) RETURNING id`, [id, `Demo ${key}`])).rows[0].id;
      owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [w, org])).rows[0].id;
    }
    people[key] = { id, email, m, owm };
  }
  const r1 = (await q<{ id: string }>(`INSERT INTO care_recipients (organization_id,first_name,last_name) VALUES ($1,'Sintetica','Carmen') RETURNING id`, [org])).rows[0].id;
  await q(`INSERT INTO family_relationships (user_id,organization_id,care_recipient_id,relationship_type,status) VALUES ($1,$2,$3,'hija','active')`, [people.familia.id, org, r1]);
  const s1 = (await q<{ id: string }>(`INSERT INTO shifts (organization_id,care_recipient_id,scheduled_start,scheduled_end,status) VALUES ($1,$2,now()-interval '1 hour',now()+interval '3 hours','confirmed') RETURNING id`, [org, r1])).rows[0].id;
  await q(`INSERT INTO assignments (organization_id,shift_id,organization_worker_membership_id,care_recipient_id,role_in_shift,response_status) VALUES ($1,$2,$3,$4,'caregiver','accepted')`, [org, s1, people.maria.owm, r1]);
  const note = (await q<{ id: string }>(`SELECT id FROM care_event_types WHERE code='NOTE'`)).rows[0].id;
  await q(`INSERT INTO care_events (organization_id,shift_id,care_recipient_id,organization_worker_membership_id,care_event_type_id,note_text) VALUES ($1,$2,$3,$4,$5,'nota sintetica')`, [org, s1, r1, people.maria.owm, note]);

  // Real sessions for everyone, and one pending reset link (familia)
  const tokens: Record<string, string> = {};
  for (const k of Object.keys(people)) {
    const r = await call("POST", "/auth/login", "", { email: people[k].email, password });
    tokens[k] = r.body.token;
  }
  check("antes: las 5 cuentas inician sesión", Object.values(tokens).every(Boolean));
  ip++;
  await call("POST", "/auth/password-reset/request", "", { email: people.familia.email });
  for (let i = 0; i < 40 && mails.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
  const pendingReset = linkToken(mails.find((m) => m.to === people.familia.email)?.html ?? "");
  check("antes: hay un enlace de recuperación pendiente (familia)", !!pendingReset);

  const snapshot = async () => (await q(`SELECT id, email, password_hash FROM users WHERE id = ANY($1) ORDER BY id`, [Object.values(people).map((p) => p.id)])).rows.map((r) => `${r.id}|${r.email}|${r.password_hash}`).join("\n");
  const openSessions = async () => (await q(`SELECT count(*)::int n FROM sessions WHERE user_id = ANY($1) AND revoked_at IS NULL`, [Object.values(people).map((p) => p.id)])).rows[0].n;
  const quiet = () => undefined;
  const aborts = async (name: string, opts: Parameters<typeof secureDemoAccounts>[1]) => {
    const before = await snapshot();
    let msg = "";
    try { await secureDemoAccounts(db, { ...opts, log: quiet }); } catch (e) { msg = (e as Error).message; }
    check(name, msg.startsWith("ABORTADO") && (await snapshot()) === before && (await openSessions()) === 5, msg.slice(0, 90));
  };

  // Guards
  await aborts("protección: número de cuentas distinto → aborta sin escribir", { orgId: org, expectedCount: 4, apply: true });
  await aborts("protección: organización equivocada → aborta sin escribir", { orgId: other, expectedCount: 5, apply: true });
  const foreignM = (await q<{ id: string }>(`INSERT INTO organization_memberships (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`, [people.carlos.id, other])).rows[0].id;
  await aborts("protección: una cuenta demo en otra agencia → aborta sin escribir", { orgId: org, expectedCount: 5, apply: true });
  await q(`DELETE FROM organization_memberships WHERE id=$1`, [foreignM]);
  await q(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [people.admin.id]);
  await aborts("protección: cuenta demo con acceso a ETNARA Central → aborta sin escribir", { orgId: org, expectedCount: 5, apply: true });
  await q(`DELETE FROM platform_admins WHERE user_id=$1`, [people.admin.id]);
  const mailbox = `owner-${randomUUID().slice(0, 6)}@example.com`;
  const clash = (await q<{ id: string }>(`INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id`, [aliasFor(mailbox, people.maria.email)])).rows[0].id;
  await aborts("protección: alias ya en uso → aborta sin escribir", { orgId: org, expectedCount: 5, aliasMailbox: mailbox, apply: true });
  await q(`DELETE FROM users WHERE id=$1`, [clash]);

  // Simulation (default): writes nothing
  const lines: string[] = [];
  const beforeSim = await snapshot();
  await secureDemoAccounts(db, { orgId: org, expectedCount: 5, aliasMailbox: mailbox, apply: false, log: (s) => lines.push(s) });
  check("simulación: no guarda nada (correos, contraseñas)", (await snapshot()) === beforeSim);
  check("simulación: no cierra sesiones", (await openSessions()) === 5);
  ip++;
  const stillIn = await call("POST", "/auth/login", "", { email: people.maria.email, password });
  check("simulación: la contraseña sigue funcionando", stillIn.status === 200);
  tokens.maria = stillIn.body.token ?? tokens.maria;
  check("simulación: informa las 5 cuentas y Casa Demo sin cambios", lines.filter((l) => l.startsWith("CUENTA ")).length === 5 && lines.some((l) => l.startsWith("CASA_DEMO_SIN_CAMBIOS")) && lines.some((l) => l.startsWith("SIMULACIÓN")));
  const leak = (ls: string[]) => ls.some((l) => /scrypt\$|[0-9a-f]{64}/.test(l) || l.includes(password));
  check("simulación: la salida no contiene hashes, tokens ni contraseñas", !leak(lines));

  const counts = async () => JSON.stringify((await q(`SELECT (SELECT count(*) FROM care_recipients WHERE organization_id=$1) r,(SELECT count(*) FROM shifts WHERE organization_id=$1) s,(SELECT count(*) FROM care_events WHERE organization_id=$1) e,(SELECT count(*) FROM organization_memberships WHERE organization_id=$1 AND status='active') m,(SELECT count(*) FROM user_roles WHERE organization_id=$1) ro,(SELECT count(*) FROM family_relationships WHERE organization_id=$1 AND status='active') f`, [org])).rows[0]);
  const countsBefore = await counts();

  // Apply, lock-only mode (e-mails unchanged)
  const applyLines: string[] = [];
  await secureDemoAccounts(db, { orgId: org, expectedCount: 5, apply: true, log: (s) => applyLines.push(s) });
  ip++;
  const oldLogins = await Promise.all(Object.values(people).map((p) => call("POST", "/auth/login", "", { email: p.email, password })));
  check("aplicar (bloqueo): la contraseña anterior ya no funciona en ninguna cuenta", oldLogins.every((r) => r.status === 401), oldLogins.map((r) => r.status).join(","));
  const oldSessions = await Promise.all(Object.values(tokens).map((t) => call("GET", "/me", t)));
  check("aplicar (bloqueo): las sesiones abiertas quedan cerradas", oldSessions.every((r) => r.status === 401), oldSessions.map((r) => r.status).join(","));
  ip++;
  const usedReset = await call("POST", "/auth/password-reset/confirm", "", { token: pendingReset, password: randomBytes(12).toString("hex") });
  check("aplicar (bloqueo): el enlace de recuperación pendiente ya no sirve", usedReset.status >= 400, `confirm -> ${usedReset.status}`);
  const stored = (await q<{ password_hash: string; email: string }>(`SELECT password_hash, email FROM users WHERE id = ANY($1)`, [Object.values(people).map((p) => p.id)])).rows;
  const verifies = await Promise.all(stored.map((r) => verifyPassword(password, r.password_hash)));
  check("aplicar (bloqueo): el hash nuevo tiene el formato de la app y no verifica la contraseña anterior", stored.every((r) => r.password_hash.startsWith("scrypt$N=16384,r=8,p=1$")) && verifies.every((v) => !v));
  check("aplicar (bloqueo): los correos no cambian", stored.every((r) => r.email.endsWith("@demo.etnara.care")));
  check("aplicar: Casa Demo intacta (residentes, turnos, registros, membresías, roles, familia)", (await counts()) === countsBefore, await counts());
  const audit = (await q<{ previous_value: Json; new_value: Json }>(`SELECT previous_value, new_value FROM audit_log WHERE action='DEMO_ACCOUNT_SECURED' AND organization_id=$1`, [org])).rows;
  check("aplicar: 5 filas de auditoría sin secretos", audit.length === 5 && !audit.some((a) => /scrypt\$|[0-9a-f]{64}/.test(JSON.stringify(a)) || JSON.stringify(a).includes(password)));
  check("aplicar: la salida no contiene hashes, tokens ni contraseñas", !leak(applyLines));

  // Recurrence: the old demo scripts must not run against a non-disposable database
  const runScript = (file: string, env: Record<string, string>) => {
    try { execFileSync("npx", ["tsx", file], { env: { ...process.env, ...env }, stdio: "pipe", timeout: 60_000 }); return "ok"; }
    catch (e) { return String((e as { stderr?: Buffer }).stderr ?? "").includes("only runs against a disposable database") ? "refused" : "error"; }
  };
  const snapRepair = await snapshot();
  for (const f of ["scripts/repairDemoAccess.ts", "scripts/createMinimalCaregiverDemo.ts", "scripts/seedDemo.ts"]) {
    const r = runScript(f, { ETNARA_DISPOSABLE_DB: "", DATABASE_URL: adminUrl!, MIGRATIONS_DATABASE_URL: adminUrl!, DEMO_PASSWORD: randomBytes(12).toString("hex") });
    check(`recurrencia: ${f.split("/")[1]} se niega fuera de una base desechable`, r === "refused", r);
  }
  const demoCount = (await q(`SELECT count(*)::int n FROM users WHERE lower(email) LIKE '%@demo.etnara.care'`)).rows[0].n;
  check("recurrencia: ningún script recreó ni cambió cuentas demo", (await snapshot()) === snapRepair && demoCount === 5);

  // Apply, alias mode: the owner takes the accounts back with the normal recovery flow
  await secureDemoAccounts(db, { orgId: org, expectedCount: 5, aliasMailbox: mailbox, apply: true, log: quiet });
  const emails = (await q<{ email: string }>(`SELECT email FROM users WHERE id = ANY($1)`, [Object.values(people).map((p) => p.id)])).rows.map((r) => r.email).sort();
  const expected = Object.values(people).map((p) => aliasFor(mailbox, p.email)).sort();
  check("aplicar (alias): los 5 correos pasan al alias del dueño", JSON.stringify(emails) === JSON.stringify(expected), emails.join(","));
  ip++;
  const alias = aliasFor(mailbox, people.maria.email);
  await call("POST", "/auth/password-reset/request", "", { email: alias });
  for (let i = 0; i < 40 && !mails.some((m) => m.to === alias); i++) await new Promise((r) => setTimeout(r, 50));
  const tok = linkToken(mails.find((m) => m.to === alias)?.html ?? "");
  check("alias: el correo de recuperación llega al alias", !!tok);
  const newPassword = randomBytes(14).toString("hex");
  ip++;
  const confirm = await call("POST", "/auth/password-reset/confirm", "", { token: tok, password: newPassword });
  ip++;
  const login = await call("POST", "/auth/login", "", { email: alias, password: newPassword });
  check("alias: la dueña fija una contraseña nueva y entra", confirm.status < 300 && login.status === 200, `${confirm.status}/${login.status}`);
  const shifts = await call("GET", `/organizations/${org}/me/shifts`, login.body.token);
  check("alias: María conserva su agencia, su rol y su turno", shifts.status === 200 && (shifts.body.shifts ?? []).some((s: Json) => s.id === s1));
  ip++;
  const demoEmailLogin = await call("POST", "/auth/login", "", { email: people.maria.email, password: newPassword });
  check("alias: el correo @demo ya no inicia sesión", demoEmailLogin.status === 401);

  server.close(); await pool.end(); await db.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  [${r.detail}]` : ""}`);
  console.log(`\nSECURE_DEMO_ACCOUNTS total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

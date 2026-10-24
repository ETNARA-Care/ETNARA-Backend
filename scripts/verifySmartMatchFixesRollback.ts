/**
 * Rollback procedure of the SmartMatch fixes (ops/110_111_smartmatch_fixes.rollback.sql):
 * it never reopens password_reset_tokens to PUBLIC, keeps 111, refuses to run
 * in unsafe states, password recovery keeps working afterwards, and 110 rolls
 * forward again. Works on its OWN temporary database (created and dropped here).
 *
 * Disposable servers only:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db>
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const ROLLBACK = readFileSync("ops/110_111_smartmatch_fixes.rollback.sql", "utf8");
const M110 = "110_schedule_commitments_and_overnight_availability.sql";
const M111 = "111_password_reset_tokens_runtime_only.sql";

async function main() {
  const tag = randomUUID().slice(0, 8).replace(/-/g, "");
  const dbName = `etnara_rb_${tag}`;
  const server = new pg.Client({ connectionString: adminUrl }); await server.connect();
  await server.query(`CREATE DATABASE ${dbName}`);
  const tempUrl = new URL(adminUrl!); tempUrl.pathname = `/${dbName}`;
  const runtimePassword = randomBytes(24).toString("hex");
  const bootstrap = () => execFileSync("npx", ["tsx", "scripts/bootstrapStaging.ts"], {
    env: { ...process.env, MIGRATIONS_DATABASE_URL: tempUrl.toString(), APP_RUNTIME_PASSWORD: runtimePassword,
      PLATFORM_ADMIN_PASSWORD: process.env.PLATFORM_ADMIN_PASSWORD ?? randomBytes(18).toString("hex"), DEMO_PASSWORD: process.env.DEMO_PASSWORD ?? randomBytes(18).toString("hex") }, stdio: "pipe",
  });
  const db = new pg.Client({ connectionString: tempUrl.toString() });
  let httpServer: import("node:http").Server | undefined;
  let pool: { end: () => Promise<void> } | undefined;
  try {
    bootstrap();
    await db.connect();
    const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(s: string, p: unknown[] = []) => db.query<T>(s, p);
    const state = async () => (await q<{ pub: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean; m110: boolean; m111: boolean; fns: number; oldc: boolean; newc: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='password_reset_tokens'::regclass AND a.grantee=0) pub,
             has_table_privilege('app_runtime','password_reset_tokens','SELECT') sel,
             has_table_privilege('app_runtime','password_reset_tokens','INSERT') ins,
             has_table_privilege('app_runtime','password_reset_tokens','UPDATE') upd,
             has_table_privilege('app_runtime','password_reset_tokens','DELETE') del,
             EXISTS (SELECT 1 FROM schema_migrations WHERE filename=$1) m110,
             EXISTS (SELECT 1 FROM schema_migrations WHERE filename=$2) m111,
             (SELECT count(*)::int FROM pg_proc WHERE proname IN ('app_smartmatch_worker_has_commitment','app_availability_covers')) fns,
             EXISTS (SELECT 1 FROM pg_constraint WHERE conname='worker_weekly_availability_check') oldc,
             EXISTS (SELECT 1 FROM pg_constraint WHERE conname='worker_weekly_availability_nonzero') newc`, [M110, M111])).rows[0];
    const run = async () => { try { await q(ROLLBACK); return "ok"; } catch (e) { await q("ROLLBACK").catch(() => undefined); return (e as Error).message; } };
    const restricted = (s: Awaited<ReturnType<typeof state>>) => !s.pub && s.sel && s.ins && s.upd && !s.del;

    check("RB0 the rollback script never grants to PUBLIC and never unregisters 111",
      !/TO\s+PUBLIC/i.test(ROLLBACK.replace(/--.*$/gm, "")) && !/DELETE FROM schema_migrations[^;]*111/i.test(ROLLBACK));

    // Fixture: a caregiver with an overnight window (as 110 allows).
    const orgId = (await q<{ id: string }>(`INSERT INTO organizations (name,organization_type,status) VALUES ('RB ${tag}','HOME_CARE_AGENCY','active') RETURNING id`)).rows[0].id;
    const wid = (await q<{ id: string }>(`INSERT INTO workers (display_name) VALUES ('RB') RETURNING id`)).rows[0].id;
    const owm = (await q<{ id: string }>(`INSERT INTO organization_worker_memberships (worker_id,organization_id,status,internal_role) VALUES ($1,$2,'active','caregiver') RETURNING id`, [wid, orgId])).rows[0].id;
    await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,5,'22:00','06:00')`, [owm, orgId]);
    const before = await state();
    const r1 = await run();
    const after1 = await state();
    check("RB1 with overnight windows the rollback stops and changes nothing (permissions stay restricted)",
      /overnight availability windows exist/.test(r1) && JSON.stringify(before) === JSON.stringify(after1) && restricted(after1), r1.slice(0, 70));

    // Unsafe states are refused before anything changes.
    await q(`DELETE FROM worker_weekly_availability WHERE organization_worker_membership_id=$1`, [owm]);
    await q(`GRANT SELECT ON password_reset_tokens TO PUBLIC`);
    const r2 = await run();
    const pubAfter = (await state());
    await q(`REVOKE ALL ON password_reset_tokens FROM PUBLIC`);
    await q(`REVOKE UPDATE ON password_reset_tokens FROM app_runtime`);
    const r3 = await run();
    const noUpd = await state();
    await q(`GRANT UPDATE ON password_reset_tokens TO app_runtime`);
    check("RB2 it refuses to run if PUBLIC holds any privilege or app_runtime lost access (nothing changed)",
      /PUBLIC holds privileges/.test(r2) && /app_runtime lacks/.test(r3) && pubAfter.m110 && pubAfter.fns === 2 && noUpd.m110 && noUpd.fns === 2, `${r2.slice(0, 40)} | ${r3.slice(0, 40)}`);

    const r4 = await run();
    const after4 = await state();
    check("RB3 the rollback removes 110 only: functions gone, old constraint back, 110 unregistered",
      r4 === "ok" && after4.fns === 0 && after4.oldc && !after4.newc && !after4.m110, `${r4} ${JSON.stringify(after4)}`);
    check("RB4 after the rollback 111 stays: PUBLIC has nothing, app_runtime keeps SELECT/INSERT/UPDATE (no DELETE)",
      restricted(after4) && after4.m111, JSON.stringify({ pub: after4.pub, sel: after4.sel, ins: after4.ins, upd: after4.upd, del: after4.del, m111: after4.m111 }));

    // Password recovery end to end as app_runtime on the rolled-back database.
    await q(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
    const ru = new URL(tempUrl.toString()); ru.username = "app_runtime"; ru.password = runtimePassword;
    process.env.DATABASE_URL = ru.toString();
    const { hashPassword } = await import("../src/security/password.js");
    const { generateSessionToken } = await import("../src/security/sessionToken.js");
    const { createApp } = await import("../src/app.js");
    ({ pool } = await import("../src/config/db.js"));
    httpServer = createApp().listen(0);
    await new Promise((r) => httpServer!.once("listening", r));
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const call = async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return res.status;
    };
    const email = `rb-${tag}@example.invalid`;
    const oldPw = randomBytes(16).toString("hex");
    const userId = (await q<{ id: string }>(`INSERT INTO users (email,password_hash,status) VALUES ($1,$2,'active') RETURNING id`, [email, await hashPassword(oldPw)])).rows[0].id;
    const reqStatus = await call("/auth/password-reset/request", { email });
    const stored = Number((await q<{ n: string }>(`SELECT count(*) n FROM password_reset_tokens WHERE user_id=$1`, [userId])).rows[0].n);
    const { rawToken, tokenHash } = generateSessionToken();
    await q(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [userId, tokenHash]);
    const newPw = randomBytes(16).toString("hex");
    const conf = await call("/auth/password-reset/confirm", { token: rawToken, password: newPw });
    const loginNew = await call("/auth/login", { email, password: newPw });
    const loginOld = await call("/auth/login", { email, password: oldPw });
    check("RB5 password recovery works after the rollback without any PUBLIC grant",
      reqStatus === 200 && stored >= 1 && conf === 200 && loginNew === 200 && loginOld === 401, `request=${reqStatus} tokens=${stored} confirm=${conf} new=${loginNew} old=${loginOld}`);

    // Roll forward: the next deploy re-applies 110; 111 is not re-run and stays effective.
    httpServer.close(); httpServer = undefined;
    await pool.end(); pool = undefined;
    bootstrap();
    const fwd = await state();
    await q(`INSERT INTO worker_weekly_availability (organization_worker_membership_id,organization_id,weekday,start_time,end_time) VALUES ($1,$2,5,'22:00','06:00')`, [owm, orgId]);
    check("RB6 roll forward: the next deploy applies 110 again (overnight windows accepted) and 111 stays effective",
      fwd.m110 && fwd.fns === 2 && fwd.newc && !fwd.oldc && restricted(fwd) && fwd.m111, JSON.stringify(fwd));
  } finally {
    if (httpServer) httpServer.close();
    if (pool) await pool.end().catch(() => undefined);
    await db.end().catch(() => undefined);
    await server.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await server.end();
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSmartMatch fixes rollback: ${results.length - failed}/${results.length} PASS`);
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });

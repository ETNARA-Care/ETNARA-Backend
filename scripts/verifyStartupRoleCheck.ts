/**
 * Security audit 26-oct-2026 — startup database role check (src/config/dbRuntimeRole.ts).
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyStartupRoleCheck.ts
 */
import pg from "pg";
import { randomBytes } from "node:crypto";
import { startupDatabaseCheck } from "../src/config/dbRuntimeRole.js";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (check: string, pass: boolean, detail = "") => results.push({ check, pass, detail });

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
async function run(url: string, requireRestricted: boolean, attempts = 2) {
  const lines: string[] = [];
  try {
    const r = await startupDatabaseCheck({ connectionString: url, requireRestricted, attempts, delayMs: 50, log: (l) => lines.push(l), exit: (c) => { throw new Exit(c); } });
    return { exit: null as number | null, lines, r };
  } catch (e) {
    if (e instanceof Exit) return { exit: e.code, lines, r: null };
    throw e;
  }
}

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const pw = randomBytes(18).toString("hex");
  await admin.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw; const runtimeUrl = u.toString();

  const sup = await run(adminUrl!, false);
  const supRole = sup.lines.find((l) => l.startsWith("DB_RUNTIME_ROLE "));
  check("R01 as postgres: starts, logs DB_RUNTIME_ROLE canBypassRls=true with a warning (no secrets in the log)",
    sup.exit === null && !!supRole && supRole.includes('"canBypassRls":true') && sup.lines.some((l) => l.startsWith("DB_RUNTIME_ROLE_WARNING"))
      && !sup.lines.join("\n").includes(pw) && !sup.lines.join("\n").includes("localhost"), sup.lines.map((l) => l.slice(0, 120)).join(" || "));
  const ready = sup.lines.find((l) => l.startsWith("DB_RUNTIME_READINESS "));
  const readiness = ready ? JSON.parse(ready.slice("DB_RUNTIME_READINESS ".length)) : null;
  check("R02 readiness (read from the postgres connection): app_runtime is safe and already holds every table privilege and function the code uses",
    !!readiness && readiness.ready === true && readiness.checkedTablePrivileges > 150 && readiness.checkedFunctions > 50,
    JSON.stringify(readiness));

  const supStrict = await run(adminUrl!, true);
  check("R03 REQUIRE_RESTRICTED_DB_ROLE=true as postgres: refuses to start (exit 1)", supStrict.exit === 1 && supStrict.lines.some((l) => l.startsWith("DB_RUNTIME_ROLE_REFUSED")), supStrict.lines.at(-1) ?? "");

  const rt = await run(runtimeUrl, true);
  const rtRole = rt.lines.find((l) => l.startsWith("DB_RUNTIME_ROLE "));
  check("R04 as app_runtime with REQUIRE_RESTRICTED_DB_ROLE=true: starts, role app_runtime, canBypassRls=false, no warning",
    rt.exit === null && !!rtRole && rtRole.includes('"role":"app_runtime"') && rtRole.includes('"canBypassRls":false') && !rt.lines.some((l) => l.includes("WARNING")), rtRole ?? rt.lines.join(" || "));

  const bad = new URL(runtimeUrl); bad.username = "etnara_no_such_role"; // local trust auth ignores passwords; an unknown role is refused everywhere
  const wrong = await run(bad.toString(), false, 2);
  check("R05 wrong credentials: retries, then exit 1 before listening (the deployment fails its healthcheck; the previous one keeps serving); the code is logged, never the password",
    wrong.exit === 1 && wrong.lines.filter((l) => l.startsWith("DB_STARTUP_CHECK attempt")).length === 2 && wrong.lines.some((l) => l.startsWith("DB_STARTUP_CHECK FAIL")) && !wrong.lines.join("\n").includes(pw),
    wrong.lines.join(" || "));

  const unreachable = new URL(runtimeUrl); unreachable.port = "1";
  const down = await run(unreachable.toString(), false, 2);
  check("R06 database unreachable: exit 1 after the retries", down.exit === 1, down.lines.at(-1) ?? "");

  // Readiness detects a missing GRANT (simulated inside a rolled-back transaction).
  await admin.query("BEGIN");
  await admin.query("REVOKE SELECT ON public.invoices FROM app_runtime");
  const { inspectRuntimeReadiness } = await import("../src/config/dbRuntimeRole.js");
  const r = await inspectRuntimeReadiness(admin);
  await admin.query("ROLLBACK");
  check("R07 readiness reports a missing privilege by name (simulated REVOKE, rolled back)", !r.ready && r.missingTablePrivileges.includes("invoices:SELECT"), JSON.stringify(r.missingTablePrivileges));

  await admin.end();
  for (const x of results) console.log(`| ${x.check} | ${x.pass ? "PASS" : "FAIL"} | ${x.detail.slice(0, 400)} |`);
  const passed = results.filter((x) => x.pass).length;
  console.log(`Runtime role: ${passed}/${results.length} ${passed === results.length ? "PASS" : "FAIL"}`);
  if (passed !== results.length) process.exitCode = 1;
}
main().catch((e) => { console.error("runtime role verification failed:", (e as Error).message); process.exit(1); });

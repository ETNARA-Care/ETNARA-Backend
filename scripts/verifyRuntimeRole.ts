/**
 * Read-only deploy gate: the connection the API will use (DATABASE_URL) must
 * be the least-privilege app_runtime role -- not a superuser, not able to
 * bypass RLS -- and must differ from the administrative migrations
 * connection. Runs no writes. Fails the deploy (exit 1) otherwise.
 *
 * Usage (e.g. as a Railway pre-deploy step after bootstrap):
 *   npx tsx scripts/verifyRuntimeRole.ts
 */
import pg from "pg";

async function main() {
  const runtimeUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!runtimeUrl) throw new Error("DATABASE_URL is required");
  if (adminUrl) {
    const r = new URL(runtimeUrl); const a = new URL(adminUrl);
    if (decodeURIComponent(r.username) === decodeURIComponent(a.username)) {
      throw new Error("DATABASE_URL uses the same database user as MIGRATIONS_DATABASE_URL");
    }
  }
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const role = (await client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
       FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    const forced = (await client.query<{ relname: string; forced: boolean }>(
      `SELECT relname, relforcerowsecurity AS forced FROM pg_class
       WHERE relname IN ('smartmatch_opportunities','smartmatch_applications') ORDER BY relname`)).rows;
    const migrations = (await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_tables WHERE tablename = 'smartmatch_application_events'`)).rows[0];
    await client.query("ROLLBACK");

    const failures: string[] = [];
    if (role.current_user !== "app_runtime") failures.push(`connected as ${role.current_user}, expected app_runtime`);
    if (role.rolsuper) failures.push("runtime role is SUPERUSER");
    if (role.rolbypassrls) failures.push("runtime role has BYPASSRLS");
    if (role.rolcreaterole || role.rolcreatedb) failures.push("runtime role can create roles/databases");
    if (forced.length !== 2 || forced.some(f => !f.forced)) failures.push("SmartMatch tables are not under FORCE ROW LEVEL SECURITY");
    if (Number(migrations.n) !== 1) failures.push("SmartMatch migrations (096) not applied");

    console.log(`runtime role: ${role.current_user} superuser=${role.rolsuper} bypassrls=${role.rolbypassrls}`);
    if (failures.length) {
      for (const f of failures) console.error(`RUNTIME_ROLE_FAIL: ${f}`);
      process.exit(1);
    }
    console.log("RUNTIME_ROLE_PASS: API connects as app_runtime, no superuser, no BYPASSRLS, RLS forced");
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error("RUNTIME_ROLE_FAIL:", (err as Error).message); process.exit(1); });

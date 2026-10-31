/**
 * 139 (dictamen app_runtime, 31-oct-2026): app_runtime no escribe en las tablas administrativas sin RLS.
 *
 * Conecta COMO app_runtime y prueba directamente en SQL, con el contexto de un superadministrador de
 * plataforma (el peor caso), que INSERT/UPDATE/DELETE en las 7 tablas fallan con 42501 y que SELECT
 * sigue funcionando. Además, guardia general: ninguna tabla sin RLS es escribible por app_runtime
 * (una tabla nueva sin RLS con escritura haría fallar la CI).
 *
 * Solo bases desechables:
 *   ETNARA_DISPOSABLE_DB=true MIGRATIONS_DATABASE_URL=postgres://<superuser>@<local>/<db> npx tsx scripts/verifyRuntimeAdminTables.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.MIGRATIONS_DATABASE_URL;
if (!adminUrl || process.env.ETNARA_DISPOSABLE_DB !== "true") throw new Error("Requires MIGRATIONS_DATABASE_URL and ETNARA_DISPOSABLE_DB=true");
if (process.env.NODE_ENV === "production") throw new Error("Production prohibited");
if (/railway|rlwy|amazonaws|supabase|neon\.tech/i.test(adminUrl)) throw new Error("Hosted database refused");

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = "") => results.push({ name, pass, detail });
const TABLES = ["platform_admins", "roles", "role_permissions", "permissions", "credential_types", "verification_methods", "schema_migrations"];

async function main() {
  const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const pw = randomBytes(24).toString("hex");
  await admin.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
  const u = new URL(adminUrl!); u.username = "app_runtime"; u.password = pw;
  const rt = new pg.Client({ connectionString: u.toString() }); await rt.connect();
  const platformUser = (await admin.query(`SELECT user_id FROM platform_admins LIMIT 1`)).rows[0]?.user_id as string | undefined;
  const actor = platformUser ?? randomUUID();
  const attempt = async (sql: string) => {
    await rt.query("BEGIN");
    try {
      await rt.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.is_superadmin',$2,true)`, [actor, platformUser ? "true" : "false"]);
      const r = await rt.query(sql); return { code: null as string | null, rows: r.rowCount ?? 0 };
    } catch (e) { return { code: (e as { code?: string }).code ?? "ERR", rows: -1 }; }
    finally { await rt.query("ROLLBACK"); }
  };
  const anyUser = (await admin.query(`SELECT id FROM users LIMIT 1`)).rows[0]?.id ?? randomUUID();
  const writes: [string, string][] = [
    ["platform_admins INSERT (hacerse superadministrador)", `INSERT INTO platform_admins (user_id) VALUES ('${anyUser}')`],
    ["platform_admins DELETE", `DELETE FROM platform_admins`],
    ["roles UPDATE", `UPDATE roles SET name = name`],
    ["roles INSERT", `INSERT INTO roles (code, name) VALUES ('X_${randomUUID().slice(0, 6)}', 'x')`],
    ["role_permissions DELETE", `DELETE FROM role_permissions`],
    ["permissions UPDATE", `UPDATE permissions SET code = code`],
    ["credential_types UPDATE", `UPDATE credential_types SET code = code`],
    ["verification_methods DELETE", `DELETE FROM verification_methods`],
    ["schema_migrations DELETE (borrar el registro de migraciones)", `DELETE FROM schema_migrations`],
    ["schema_migrations INSERT", `INSERT INTO schema_migrations (filename) VALUES ('999_falsa.sql')`],
  ];
  for (const [name, sql] of writes) {
    const r = await attempt(sql);
    check(`W app_runtime: ${name} → 42501`, r.code === "42501", JSON.stringify(r));
  }
  for (const t of TABLES.filter((t) => t !== "schema_migrations")) {
    const r = await attempt(`SELECT count(*) FROM ${t}`);
    check(`R app_runtime sigue leyendo ${t}`, r.code === null, JSON.stringify(r));
  }
  const open = (await admin.query(`SELECT DISTINCT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
       AND (has_table_privilege('app_runtime', c.oid, 'INSERT') OR has_table_privilege('app_runtime', c.oid, 'UPDATE') OR has_table_privilege('app_runtime', c.oid, 'DELETE'))`)).rows.map((r) => r.relname);
  check("G guardia: ninguna tabla sin RLS es escribible por app_runtime", open.length === 0, open.join(","));
  const migrated = (await admin.query(`SELECT 1 FROM schema_migrations WHERE filename='139_runtime_revoke_admin_table_writes.sql'`)).rowCount === 1;
  check("M la migración 139 está registrada", migrated);
  await rt.end(); await admin.end();
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (${r.detail})`}`);
  console.log(`\nRUNTIME_ADMIN_TABLES ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

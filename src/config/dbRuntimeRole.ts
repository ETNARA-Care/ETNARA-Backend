import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * Database role check at startup (security audit 26-oct-2026).
 *
 * The backend must run as `app_runtime` (NOSUPERUSER, NOBYPASSRLS, owns no table) so that PostgreSQL row level
 * security protects every agency even if application code has a bug. `postgres` is for migrations only.
 *
 * At startup, BEFORE the server accepts traffic:
 *  1. Connect with DATABASE_URL (a few retries). If the database cannot be reached, exit(1): a deployment with a
 *     wrong connection string then fails its healthcheck and Railway keeps the previous deployment serving.
 *  2. Log one line `DB_RUNTIME_ROLE {...}`: the connected role and whether it can bypass RLS (no secrets, no host).
 *  3. Log one line `DB_RUNTIME_READINESS {...}`: whether `app_runtime` already holds every table privilege and
 *     function the code uses (runtimePrivileges.generated.json). Names of what is missing, nothing else.
 *  4. If REQUIRE_RESTRICTED_DB_ROLE=true and the connected role can bypass RLS, exit(1) (after the switch, so a
 *     wrong variable can never silently put production back on the superuser).
 * Everything here is read-only catalog access.
 */
export interface RuntimeRoleReport {
  role: string; sessionRole: string; superuser: boolean; bypassrls: boolean; createrole: boolean;
  ownsPublicTables: number; publicTables: number; rlsEnabledTables: number; canBypassRls: boolean;
}
export interface RuntimeReadinessReport {
  appRuntimeExists: boolean; appRuntimeSafe: boolean;
  checkedTablePrivileges: number; checkedFunctions: number;
  missingTablePrivileges: string[]; missingFunctions: string[]; ready: boolean;
}

type Manifest = { tables: Record<string, string[]>; functions: string[] };
export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(new URL("./runtimePrivileges.generated.json", import.meta.url), "utf8")) as Manifest;
}

export async function inspectRuntimeRole(client: pg.ClientBase): Promise<RuntimeRoleReport> {
  const r = (await client.query<{
    role: string; session_role: string; superuser: boolean; bypassrls: boolean; createrole: boolean; owned: number; tables: number; rls: number;
  }>(`SELECT current_user AS role, session_user AS session_role,
            r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, r.rolcreaterole AS createrole,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owned,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) AS tables,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity) AS rls
       FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  return {
    role: r.role, sessionRole: r.session_role, superuser: r.superuser, bypassrls: r.bypassrls, createrole: r.createrole,
    ownsPublicTables: r.owned, publicTables: r.tables, rlsEnabledTables: r.rls,
    // Superusers and BYPASSRLS roles skip every policy; table owners skip policies unless FORCE ROW LEVEL SECURITY.
    canBypassRls: r.superuser || r.bypassrls || r.owned > 0,
  };
}

export async function inspectRuntimeReadiness(client: pg.ClientBase, manifest: Manifest = loadManifest()): Promise<RuntimeReadinessReport> {
  const role = (await client.query<{ superuser: boolean; bypassrls: boolean; owned: number }>(
    `SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND pg_has_role('app_runtime', c.relowner, 'USAGE')) AS owned
       FROM pg_roles r WHERE r.rolname = 'app_runtime'`)).rows[0];
  if (!role) return { appRuntimeExists: false, appRuntimeSafe: false, checkedTablePrivileges: 0, checkedFunctions: 0, missingTablePrivileges: [], missingFunctions: [], ready: false };
  const pairs = Object.entries(manifest.tables).flatMap(([t, privs]) => privs.map((p) => [t, p] as const));
  // INSERT/UPDATE may be granted per column (billing, SmartMatch…): any column is enough here; the CI suites
  // exercise the exact columns.
  const tableRows = (await client.query<{ t: string; p: string; ok: boolean }>(
    `SELECT x.t, x.p,
            CASE WHEN x.p IN ('INSERT','UPDATE') THEN has_any_column_privilege('app_runtime', c.oid, x.p)
                 ELSE has_table_privilege('app_runtime', c.oid, x.p) END AS ok
       FROM unnest($1::text[], $2::text[]) AS x(t, p)
       JOIN pg_class c ON c.relname = x.t AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v')`,
    [pairs.map(([t]) => t), pairs.map(([, p]) => p)])).rows;
  const fnRows = (await client.query<{ f: string; ok: boolean }>(
    `SELECT f.name AS f, bool_and(has_function_privilege('app_runtime', p.oid, 'EXECUTE')) AS ok
       FROM unnest($1::text[]) AS f(name) JOIN pg_proc p ON p.proname = f.name AND p.pronamespace = 'public'::regnamespace
      GROUP BY f.name`, [manifest.functions])).rows;
  const missingTablePrivileges = tableRows.filter((r) => !r.ok).map((r) => `${r.t}:${r.p}`).sort();
  const missingFunctions = fnRows.filter((r) => !r.ok).map((r) => r.f).sort();
  const appRuntimeSafe = !role.superuser && !role.bypassrls && role.owned === 0;
  return {
    appRuntimeExists: true, appRuntimeSafe, checkedTablePrivileges: tableRows.length, checkedFunctions: fnRows.length,
    missingTablePrivileges, missingFunctions, ready: appRuntimeSafe && missingTablePrivileges.length === 0 && missingFunctions.length === 0,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs before app.listen(). Returns normally when the server may start; otherwise exits the process. */
export async function startupDatabaseCheck(opts: {
  connectionString: string; requireRestricted: boolean; attempts?: number; delayMs?: number;
  log?: (line: string) => void; exit?: (code: number) => never;
}): Promise<{ role: RuntimeRoleReport; readiness: RuntimeReadinessReport | null }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const attempts = opts.attempts ?? 5;
  let lastCode = "UNKNOWN";
  let found: { role: RuntimeRoleReport; readiness: RuntimeReadinessReport | null } | null = null;
  for (let i = 1; i <= attempts && !found; i++) {
    const client = new pg.Client({ connectionString: opts.connectionString, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      await client.query("BEGIN TRANSACTION READ ONLY");
      const role = await inspectRuntimeRole(client);
      let readiness: RuntimeReadinessReport | null = null;
      try { readiness = await inspectRuntimeReadiness(client); } catch { readiness = null; }
      await client.query("ROLLBACK");
      found = { role, readiness };
    } catch (e) {
      lastCode = (e as { code?: string }).code ?? (e as Error).name ?? "ERROR";
      log(`DB_STARTUP_CHECK attempt ${i}/${attempts} failed ${JSON.stringify({ code: lastCode })}`);
      if (i < attempts) await sleep((opts.delayMs ?? 3000) * i);
    } finally { await client.end().catch(() => undefined); }
  }
  if (found) {
    const { role, readiness } = found;
    log(`DB_RUNTIME_ROLE ${JSON.stringify({ role: role.role, sessionRole: role.sessionRole, superuser: role.superuser, bypassrls: role.bypassrls, ownsPublicTables: role.ownsPublicTables, rlsEnabledTables: role.rlsEnabledTables, publicTables: role.publicTables, canBypassRls: role.canBypassRls, requireRestricted: opts.requireRestricted })}`);
    if (readiness) log(`DB_RUNTIME_READINESS ${JSON.stringify(readiness)}`);
    if (role.canBypassRls) {
      log("DB_RUNTIME_ROLE_WARNING the backend is connected as a role that bypasses row level security; it must use app_runtime");
      if (opts.requireRestricted) { log("DB_RUNTIME_ROLE_REFUSED REQUIRE_RESTRICTED_DB_ROLE=true"); return exit(1); }
    }
    return found;
  }
  log(`DB_STARTUP_CHECK FAIL ${JSON.stringify({ code: lastCode })}`);
  return exit(1);
}

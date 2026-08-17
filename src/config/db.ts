import { Pool, type PoolClient, types as pgTypes } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { env } from "./env.js";

/**
 * BUG FIX (found via real test execution, not by inspection): by default,
 * node-postgres parses PostgreSQL `date` columns (OID 1082) into JS `Date`
 * objects. Every type annotation in this codebase treats date columns as
 * plain 'YYYY-MM-DD' strings (credentials.expires_at, .issued_at,
 * care_recipients.date_of_birth, etc.), and comparisons like
 * `expires_at >= today` were written assuming string comparison. Comparing
 * a Date object against a string coerces the Date via its default
 * .toString() (e.g. "Wed Aug 16 2026 00:00:00 GMT+0000..."), which does NOT
 * sort lexicographically the same as ISO 'YYYY-MM-DD' -- producing silently
 * wrong results. This one line fixes it everywhere at once, rather than
 * patching every individual query.
 */
pgTypes.setTypeParser(1082, (val) => val);

/**
 * A single, reusable connection pool for the whole application. No
 * endpoint or service creates its own `new Pool()` -- everything shares
 * this one, exactly as required.
 *
 * This pool authenticates using whatever role is embedded in
 * DATABASE_URL. In real deployments (test/production), that connection
 * string MUST point at the app_runtime role approved in
 * 017_runtime_security.sql -- a role with NOBYPASSRLS, no SUPERUSER, and
 * table-level privileges restricted exactly as that migration defines.
 * This file does not and cannot grant any RLS bypass -- that guarantee
 * lives entirely in PostgreSQL role configuration, not in application
 * code, which is exactly the point of enforcing it at the database layer.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PGPOOL_MAX,
});

pool.on("error", (err) => {
  // A background/idle client emitted an error (e.g. connection reset).
  // This must never crash the whole process silently -- log and let the
  // pool recover on next checkout.
  // eslint-disable-next-line no-console
  console.error("Unexpected PostgreSQL pool error on idle client", err);
});

export interface Database {
  // Intentionally left minimal for this stage: only the DB/context layer
  // is being built right now, not product modules. Table typings for
  // Kysely are added incrementally as each module (careRecipients, family,
  // workforce, ...) is implemented -- adding them all now, before any
  // query uses them, would be speculative typing with nothing to validate
  // it against yet.
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Graceful shutdown: closes the pool cleanly. Required for tests (so the
 * process can exit instead of hanging on open connections) and for real
 * process shutdown (SIGTERM from Railway).
 */
export async function closeDb(): Promise<void> {
  await db.destroy();
}

/**
 * Escape hatch used ONLY by tenantContext.ts to obtain a raw pg client for
 * a transaction it fully controls (BEGIN / SET LOCAL / ... / COMMIT). No
 * other module should call this directly -- product code always goes
 * through withTenantContext() or withPlatformContext().
 */
export async function acquireRawClient(): Promise<PoolClient> {
  return pool.connect();
}

import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { db, type Database } from "../config/db.js";
import {
  InvalidTenantContextError,
  MembershipNotActiveError,
  UnauthorizedPlatformAccessError,
} from "./errors.js";

const uuidSchema = z.string().uuid();

export interface TenantContext {
  userId: string;
  organizationId: string;
}
// Deliberately NO `isSuperadmin: boolean` field here. Platform-level
// privilege is never carried as a trusted flag on this type -- see
// withPlatformContext() below, which is the only path to a privileged
// transaction, and which independently re-verifies authority against
// platform_admins every single time it is called.

function assertValidUuid(value: string, label: string): void {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidTenantContextError(
      `${label} must be a valid UUID, received: ${JSON.stringify(value)}`
    );
  }
}

/**
 * Runs `work` inside a single PostgreSQL transaction with the tenant
 * security context established via SET LOCAL (through the parameterized
 * set_config() function -- never string concatenation).
 *
 * Sequence:
 *   BEGIN (via Kysely's db.transaction())
 *   -> set_config('app.current_user_id', ..., true)
 *   -> set_config('app.current_org_id', ..., true)
 *   -> set_config('app.is_superadmin', 'false', true)
 *   -> explicit membership validation (fails closed, before any product
 *      query runs)
 *   -> work(trx)
 *   COMMIT on success / ROLLBACK on any thrown error (Kysely's
 *   transaction().execute() handles this automatically)
 *
 * Kysely's `trx` here is the SAME physical connection/transaction that the
 * set_config() calls ran on -- db.transaction().execute() acquires exactly
 * one connection for the whole callback, so there is no risk of the SET
 * LOCAL happening on one connection and the product queries on another.
 */
export async function withTenantContext<T>(
  ctx: TenantContext,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  assertValidUuid(ctx.userId, "userId");
  assertValidUuid(ctx.organizationId, "organizationId");

  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
    await sql`SELECT set_config('app.current_org_id', ${ctx.organizationId}, true)`.execute(trx);
    await sql`SELECT set_config('app.is_superadmin', 'false', true)`.execute(trx);

    // Explicit, human-readable authorization check BEFORE any product
    // query runs. This is defense in depth on top of RLS (which already
    // independently protects every table): RLS alone would just make an
    // unauthorized query return zero rows; this check turns that into a
    // clear, catchable error instead of a silent empty result, and
    // guarantees `work()` never executes at all for an invalid org
    // selection.
    const membership = await sql<{ id: string }>`
      SELECT id FROM organization_memberships
      WHERE user_id = ${ctx.userId}
        AND organization_id = ${ctx.organizationId}
        AND status = 'active'
      LIMIT 1
    `.execute(trx);

    if (membership.rows.length === 0) {
      throw new MembershipNotActiveError(
        `User ${ctx.userId} has no active membership in organization ${ctx.organizationId}`
      );
    }

    return work(trx);
  });
}

async function isActivePlatformAdmin(userId: string): Promise<boolean> {
  const result = await sql<{ user_id: string }>`
    SELECT user_id FROM platform_admins
    WHERE user_id = ${userId} AND revoked_at IS NULL
    LIMIT 1
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * The ONLY path to a privileged (is_superadmin='true') transaction.
 *
 * Authority is derived exclusively from a verified row in platform_admins
 * -- never from a boolean passed by a caller, a header, or any other
 * client-controlled input. The check happens BEFORE any transaction (let
 * alone a privileged one) is opened: an unauthorized userId never gets as
 * far as BEGIN.
 *
 * Even after this passes and sets app.is_superadmin = 'true' inside the
 * transaction, the database's own app_is_superadmin() function (see
 * 018_rls_hardening.sql) independently re-checks platform_admins again on
 * every RLS evaluation. Two independent layers must both agree; neither
 * one alone is sufficient. Setting the GUC by itself, without this
 * verified call path, grants nothing.
 */
export async function withPlatformContext<T>(
  userId: string,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  assertValidUuid(userId, "userId");

  const authorized = await isActivePlatformAdmin(userId);
  if (!authorized) {
    throw new UnauthorizedPlatformAccessError(
      `User ${userId} is not an active, unrevoked platform admin`
    );
  }

  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    await sql`SELECT set_config('app.is_superadmin', 'true', true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Sets ONLY app.current_user_id -- no organization, no superadmin. Used for
 * genuinely user-self-scoped operations that must work BEFORE any single
 * organization is selected (e.g. GET /me listing every org a user belongs
 * to). Relies on the auth-bootstrap RLS policies (020_auth_bootstrap_rls.sql)
 * that allow a user to read their own organization_memberships / user_roles
 * / organizations rows via user_id = current_user_id, without needing
 * current_org_id to already match one specific tenant.
 */
export async function withUserContext<T>(
  userId: string,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  assertValidUuid(userId, "userId");
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    await sql`SELECT set_config('app.current_org_id', '', true)`.execute(trx);
    await sql`SELECT set_config('app.is_superadmin', 'false', true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Sets ONLY app.lookup_token_hash -- used exclusively by the auth
 * middleware to resolve a raw session token (already hashed server-side)
 * into a session row, before any user identity is known at all. See
 * sessions_token_lookup policy in 020_auth_bootstrap_rls.sql.
 */
export async function withTokenLookupContext<T>(
  tokenHash: string,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.lookup_token_hash', ${tokenHash}, true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Sets ONLY app.lookup_identifier -- used exclusively by login to resolve
 * an email/phone identifier into a user row, before any identity exists
 * yet. The identifier here is the ALREADY-NORMALIZED value the backend
 * computed from validated input -- never the raw client body passed
 * through untouched. See users_login_lookup policy in
 * 020_auth_bootstrap_rls.sql.
 */
export async function withLoginLookupContext<T>(
  identifier: string,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.lookup_identifier', ${identifier}, true)`.execute(trx);
    return work(trx);
  });
}

/**
 * Sets BOTH current_user_id and current_org_id, WITHOUT the pre-existing
 * membership check that withTenantContext() performs. This is the ONE
 * legitimate exception to "every tenant-owned operation goes through
 * withTenantContext()": the exact moment a brand-new organization
 * membership is being CREATED (e.g. accepting a family invitation for the
 * first time), where by definition no active membership exists yet for
 * withTenantContext's own check to find.
 *
 * Safety: this function grants NOTHING by itself -- every table's RLS
 * policy still applies in full (organization_memberships' own INSERT
 * check still requires organization_id = current_org_id, family_roles and
 * family_relationships likewise). The only thing this skips is the extra
 * "does a membership already exist" pre-check, which is inappropriate
 * exactly here because creating that membership IS the operation being
 * performed. Never call this to bypass authorization -- callers must
 * independently verify (e.g. a validated, unexpired, unrevoked invitation
 * token) that the caller is legitimately allowed to gain membership in
 * this organization before ever reaching this function.
 */
export async function withNewMembershipContext<T>(
  userId: string,
  organizationId: string,
  work: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  assertValidUuid(userId, "userId");
  assertValidUuid(organizationId, "organizationId");
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    await sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`.execute(trx);
    await sql`SELECT set_config('app.is_superadmin', 'false', true)`.execute(trx);
    return work(trx);
  });
}

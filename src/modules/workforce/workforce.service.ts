import { sql } from "kysely";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

export class MembershipNotFoundError extends Error {
  constructor() {
    super("MEMBERSHIP_NOT_FOUND");
    this.name = "MembershipNotFoundError";
  }
}

/**
 * The agency changed the name of someone whose membership in it is inactive (decisión de Rafa,
 * 30-oct-2026): the profile is shared with other agencies, so only an agency where she is active
 * edits it. Reactivate first. Never a silent "saved".
 */
export class WorkerMembershipInactiveError extends Error {
  constructor() {
    super("WORKER_MEMBERSHIP_INACTIVE");
    this.name = "WorkerMembershipInactiveError";
  }
}

/** The name change reached no row (it must never be reported as saved). */
export class WorkerProfileNotSavedError extends Error {
  constructor() {
    super("WORKER_PROFILE_NOT_SAVED");
    this.name = "WorkerProfileNotSavedError";
  }
}

export class WorkforceManagementForbiddenError extends Error {
  constructor() {
    super("WORKFORCE_MANAGEMENT_FORBIDDEN");
    this.name = "WorkforceManagementForbiddenError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const createWorkerSchema = z
  .object({
    workerId: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(120),
    internalRole: z.string().min(1),
    hiredAt: z.string().date().optional(),
  })
  .refine((d) => true, {});
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;

const updateMembershipSchema = z
  .object({
    internalRole: z.string().min(1),
    displayName: z.string().trim().min(1).max(120),
    status: z.enum(["active", "inactive"]),
    hiredAt: z.string().date().nullable(),
    endedAt: z.string().datetime().nullable(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field required" });
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;
export { updateMembershipSchema };

interface MembershipRow {
  id: string;
  worker_id: string;
  organization_id: string;
  status: string;
  internal_role: string;
  hired_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  display_name: string | null;
}

async function assertWorkforceManager(trx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) {
  const result = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx);
  if (!result.rows[0]?.is_manager) throw new WorkforceManagementForbiddenError();
}

export async function createOrLinkWorker(
  userId: string,
  organizationId: string,
  input: CreateWorkerInput
): Promise<MembershipRow> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkforceManager(trx);
    let workerId = input.workerId;

    if (workerId) {
      // Only a profile this agency can already see (own staff, or the caller's
      // own profile). Never another agency's caregiver: without this filter a
      // manager could rename and link any caregiver by id (auditoría M1).
      // Same rule as RLS workers_self_or_shared_org.
      const existing = await sql<{ id: string }>`
        SELECT w.id FROM workers w
        WHERE w.id = ${workerId}
          AND (w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            OR EXISTS (SELECT 1 FROM organization_worker_memberships owm
                       WHERE owm.worker_id = w.id AND owm.organization_id = ${organizationId} AND owm.status = 'active'))
        LIMIT 1`.execute(trx);
      if (!existing.rows[0]) {
        const err = new Error("WORKER_NOT_FOUND");
        err.name = "WorkerNotFoundError";
        throw err;
      }
      await sql`UPDATE workers SET display_name = ${input.displayName}, updated_at = now() WHERE id = ${workerId}`.execute(trx);
    } else {
      // Generate the id client-side and INSERT it explicitly, deliberately
      // avoiding RETURNING id here: a freshly-created worker with no
      // user_id and no membership yet is legitimately not SELECT-visible
      // under workers' own RLS policies at this exact instant (correct --
      // it becomes visible the moment the membership below is created).
      // RETURNING would require that same-instant visibility and fail.
      workerId = randomUUID();
      await sql`
        INSERT INTO workers (id, display_name) VALUES (${workerId}, ${input.displayName})
      `.execute(trx);
    }

    const existingMembership = await sql<{ id: string }>`
      SELECT id FROM organization_worker_memberships
      WHERE worker_id = ${workerId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (existingMembership.rows[0]) {
      const err = new Error("MEMBERSHIP_ALREADY_EXISTS");
      err.name = "MembershipAlreadyExistsError";
      throw err;
    }

    const result = await sql<Omit<MembershipRow, "display_name">>`
      INSERT INTO organization_worker_memberships (worker_id, organization_id, internal_role, hired_at)
      VALUES (${workerId}, ${organizationId}, ${input.internalRole}, ${input.hiredAt ?? null})
      RETURNING id, worker_id, organization_id, status, internal_role, hired_at, ended_at, created_at, updated_at
    `.execute(trx);
    return { ...result.rows[0], display_name: input.displayName };
  });
}

/** Managers and establishment administrators see the roster (same staff set as RLS staff_write). */
async function assertRosterReader(trx: Parameters<Parameters<typeof withTenantContext>[1]>[0], ownMembershipId?: string) {
  const r = await sql<{ ok: boolean }>`
    SELECT (app_is_org_manager() OR app_is_any_establishment_admin()
      OR (${ownMembershipId ?? null}::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
        WHERE owm.id = ${ownMembershipId ?? null}::uuid
          AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid))) AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new WorkforceManagementForbiddenError();
}

export async function listWorkforce(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // Family and caregivers do not see the roster (names, dates, credentials).
    await assertRosterReader(trx);
    const result = await sql<MembershipRow & { display_name: string | null }>`
      SELECT owm.id, owm.worker_id, owm.organization_id, owm.status, owm.internal_role,
             owm.hired_at, owm.ended_at, owm.created_at, owm.updated_at, w.display_name
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      WHERE owm.organization_id = ${organizationId}
      ORDER BY owm.created_at
    `.execute(trx);
    return result.rows;
  });
}

interface WorkerProfileRow extends MembershipRow {
  default_scope: string;
}

export async function getWorkerProfile(userId: string, organizationId: string, membershipId: string) {
  assertUuid(membershipId, "organizationWorkerMembershipId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // Managers, establishment administrators, or the caregiver's own profile.
    await assertRosterReader(trx, membershipId);
    const membershipResult = await sql<WorkerProfileRow>`
      SELECT owm.id, owm.worker_id, owm.organization_id, owm.status, owm.internal_role,
             owm.hired_at, owm.ended_at, owm.created_at, owm.updated_at, w.default_scope, w.display_name
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      WHERE owm.id = ${membershipId} AND owm.organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    const membership = membershipResult.rows[0];
    if (!membership) throw new MembershipNotFoundError();

    const credentialsResult = await sql<{
      id: string;
      type_code: string;
      status: string;
      expires_at: string | null;
    }>`
      SELECT c.id, ct.code as type_code, c.status, c.expires_at
      FROM credentials c
      JOIN credential_types ct ON ct.id = c.credential_type_id
      WHERE c.worker_id = ${membership.worker_id}
      ORDER BY ct.code
    `.execute(trx);

    return { membership, credentialsSummary: credentialsResult.rows };
  });
}

export async function updateMembership(
  userId: string,
  organizationId: string,
  membershipId: string,
  input: UpdateMembershipInput
): Promise<MembershipRow> {
  assertUuid(membershipId, "organizationWorkerMembershipId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkforceManager(trx);
    const current = await sql<{ display_name: string | null; status: string }>`
      SELECT w.display_name, owm.status
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      WHERE owm.id = ${membershipId} AND owm.organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!current.rows[0]) throw new MembershipNotFoundError();

    // The portal always sends the name; only an actual change counts. A change needs the
    // membership to be active once this request is applied (reactivate + rename together is fine).
    const renaming = input.displayName !== undefined && input.displayName !== (current.rows[0].display_name ?? "").trim();
    const effectiveStatus = input.status ?? current.rows[0].status;
    if (renaming && effectiveStatus !== "active") throw new WorkerMembershipInactiveError();
    const fragments = [];
    if (input.internalRole !== undefined) fragments.push(sql`internal_role = ${input.internalRole}`);
    if (input.status !== undefined) fragments.push(sql`status = ${input.status}`);
    if (input.hiredAt !== undefined) fragments.push(sql`hired_at = ${input.hiredAt}`);
    if (input.endedAt !== undefined) fragments.push(sql`ended_at = ${input.endedAt}`);
    fragments.push(sql`updated_at = now()`);

    const result = await sql<Omit<MembershipRow, "display_name">>`
      UPDATE organization_worker_memberships
      SET ${sql.join(fragments, sql`, `)}
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      RETURNING id, worker_id, organization_id, status, internal_role, hired_at, ended_at, created_at, updated_at
    `.execute(trx);
    if (!result.rows[0]) throw new MembershipNotFoundError();

    // After the status (so a reactivated membership is already active for RLS under app_runtime).
    if (renaming) {
      const renamed = await sql<{ id: string }>`
        UPDATE workers w
        SET display_name = ${input.displayName!}, updated_at = now()
        FROM organization_worker_memberships owm
        WHERE owm.id = ${membershipId}
          AND owm.organization_id = ${organizationId}
          AND owm.status = 'active'
          AND w.id = owm.worker_id
        RETURNING w.id
      `.execute(trx);
      if (!renamed.rows[0]) throw new WorkerProfileNotSavedError();
    }

    if (input.status !== undefined && input.status !== current.rows[0].status) {
      await sql`
        INSERT INTO audit_log (
          actor_user_id, organization_id, target_organization_id, action,
          entity_type, entity_id, previous_value, new_value
        ) VALUES (
          ${userId}, ${organizationId}, ${organizationId},
          'WORKER_MEMBERSHIP_STATUS_CHANGED', 'organization_worker_membership', ${membershipId},
          jsonb_build_object('status', ${current.rows[0].status}::text),
          jsonb_build_object('status', ${input.status}::text)
        )
      `.execute(trx);
    }

    return { ...result.rows[0], display_name: renaming ? input.displayName! : current.rows[0].display_name };
  });
}

export async function deactivateMembership(userId: string, organizationId: string, membershipId: string) {
  return updateMembership(userId, organizationId, membershipId, {
    status: "inactive",
    endedAt: new Date().toISOString(),
  });
}

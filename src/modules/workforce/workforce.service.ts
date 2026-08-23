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

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const createWorkerSchema = z
  .object({
    workerId: z.string().uuid().optional(),
    internalRole: z.string().min(1),
    hiredAt: z.string().date().optional(),
  })
  .refine((d) => true, {});
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;

const updateMembershipSchema = z
  .object({
    internalRole: z.string().min(1),
    status: z.enum(["active", "inactive"]),
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
}

export async function createOrLinkWorker(
  userId: string,
  organizationId: string,
  input: CreateWorkerInput
): Promise<MembershipRow> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    let workerId = input.workerId;

    if (workerId) {
      const existing = await sql<{ id: string }>`SELECT id FROM workers WHERE id = ${workerId} LIMIT 1`.execute(
        trx
      );
      if (!existing.rows[0]) {
        const err = new Error("WORKER_NOT_FOUND");
        err.name = "WorkerNotFoundError";
        throw err;
      }
    } else {
      // Generate the id client-side and INSERT it explicitly, deliberately
      // avoiding RETURNING id here: a freshly-created worker with no
      // user_id and no membership yet is legitimately not SELECT-visible
      // under workers' own RLS policies at this exact instant (correct --
      // it becomes visible the moment the membership below is created).
      // RETURNING would require that same-instant visibility and fail.
      workerId = randomUUID();
      await sql`
        INSERT INTO workers (id) VALUES (${workerId})
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

    const result = await sql<MembershipRow>`
      INSERT INTO organization_worker_memberships (worker_id, organization_id, internal_role, hired_at)
      VALUES (${workerId}, ${organizationId}, ${input.internalRole}, ${input.hiredAt ?? null})
      RETURNING id, worker_id, organization_id, status, internal_role, hired_at, ended_at, created_at, updated_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listWorkforce(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
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
    const membershipResult = await sql<WorkerProfileRow>`
      SELECT owm.id, owm.worker_id, owm.organization_id, owm.status, owm.internal_role,
             owm.hired_at, owm.ended_at, owm.created_at, owm.updated_at, w.default_scope
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
    const fragments = [];
    if (input.internalRole !== undefined) fragments.push(sql`internal_role = ${input.internalRole}`);
    if (input.status !== undefined) fragments.push(sql`status = ${input.status}`);
    if (input.endedAt !== undefined) fragments.push(sql`ended_at = ${input.endedAt}`);
    fragments.push(sql`updated_at = now()`);

    const result = await sql<MembershipRow>`
      UPDATE organization_worker_memberships
      SET ${sql.join(fragments, sql`, `)}
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      RETURNING id, worker_id, organization_id, status, internal_role, hired_at, ended_at, created_at, updated_at
    `.execute(trx);
    if (!result.rows[0]) throw new MembershipNotFoundError();
    return result.rows[0];
  });
}

export async function deactivateMembership(userId: string, organizationId: string, membershipId: string) {
  return updateMembership(userId, organizationId, membershipId, {
    status: "inactive",
    endedAt: new Date().toISOString(),
  });
}

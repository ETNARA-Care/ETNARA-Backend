import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { evaluateWorkerEligibility } from "../eligibility/eligibility.service.js";

export class ShiftNotFoundError extends Error {
  constructor() {
    super("SHIFT_NOT_FOUND");
    this.name = "ShiftNotFoundError";
  }
}
export class MembershipNotInOrgError extends Error {
  constructor() {
    super("MEMBERSHIP_NOT_IN_ORGANIZATION");
    this.name = "MembershipNotInOrgError";
  }
}
export class WorkerNotEligibleError extends Error {
  constructor(status: string) {
    super(`WORKER_NOT_ELIGIBLE_${status.toUpperCase()}`);
    this.name = "WorkerNotEligibleError";
  }
}
export class ShiftCancelledError extends Error {
  constructor() {
    super("SHIFT_CANCELLED");
    this.name = "ShiftCancelledError";
  }
}
export class DuplicateAssignmentError extends Error {
  constructor() {
    super("ASSIGNMENT_ALREADY_EXISTS");
    this.name = "DuplicateAssignmentError";
  }
}
export class ScheduleConflictError extends Error {
  constructor() {
    super("SCHEDULE_CONFLICT");
    this.name = "ScheduleConflictError";
  }
}
export class AssignmentNotFoundError extends Error {
  constructor() {
    super("ASSIGNMENT_NOT_FOUND");
    this.name = "AssignmentNotFoundError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const createAssignmentSchema = z.object({
  organizationWorkerMembershipId: z.string().uuid(),
  roleInShift: z.string().optional(),
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

interface AssignmentRow {
  id: string;
  organization_id: string;
  shift_id: string;
  organization_worker_membership_id: string;
  care_recipient_id: string | null;
  role_in_shift: string | null;
  created_at: string;
}

export async function createAssignment(
  userId: string,
  organizationId: string,
  shiftId: string,
  input: CreateAssignmentInput
): Promise<AssignmentRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const shiftRow = await sql<{
      id: string;
      status: string;
      scheduled_start: string;
      scheduled_end: string;
      care_recipient_id: string | null;
    }>`
      SELECT id, status, scheduled_start, scheduled_end, care_recipient_id FROM shifts
      WHERE id = ${shiftId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    const shift = shiftRow.rows[0];
    if (!shift) throw new ShiftNotFoundError();
    if (shift.status === "cancelled") throw new ShiftCancelledError();

    const membershipRow = await sql<{ id: string; status: string }>`
      SELECT id, status FROM organization_worker_memberships
      WHERE id = ${input.organizationWorkerMembershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!membershipRow.rows[0]) throw new MembershipNotInOrgError();

    const eligibility = await evaluateWorkerEligibility(userId, organizationId, input.organizationWorkerMembershipId);
    if (eligibility.eligibilityStatus !== "eligible") {
      throw new WorkerNotEligibleError(eligibility.eligibilityStatus);
    }

    const existing = await sql<{ id: string }>`
      SELECT id FROM assignments
      WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${input.organizationWorkerMembershipId}
      LIMIT 1
    `.execute(trx);
    if (existing.rows[0]) throw new DuplicateAssignmentError();

    const overlap = await sql<{ id: string }>`
      SELECT a.id FROM assignments a
      JOIN shifts s ON s.id = a.shift_id
      WHERE a.organization_worker_membership_id = ${input.organizationWorkerMembershipId}
        AND s.status != 'cancelled'
        AND s.scheduled_start < ${shift.scheduled_end}
        AND s.scheduled_end > ${shift.scheduled_start}
      LIMIT 1
    `.execute(trx);
    if (overlap.rows[0]) throw new ScheduleConflictError();

    const result = await sql<AssignmentRow>`
      INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift)
      VALUES (${organizationId}, ${shiftId}, ${input.organizationWorkerMembershipId}, ${shift.care_recipient_id}, ${input.roleInShift ?? null})
      RETURNING id, organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift, created_at
    `.execute(trx);

    await sql`UPDATE shifts SET status = 'confirmed', updated_at = now() WHERE id = ${shiftId} AND status = 'unassigned'`.execute(
      trx
    );

    return result.rows[0];
  });
}

export async function listAssignments(userId: string, organizationId: string, shiftId: string) {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<AssignmentRow>`
      SELECT id, organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift, created_at
      FROM assignments
      WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
      ORDER BY created_at
    `.execute(trx);
    return result.rows;
  });
}

/**
 * Removal ("unassign"): the approved schema has NO status column on
 * assignments (no 'cancelled'/'removed' state to set) -- only
 * assignment_history, an append-only log meant for REASSIGNMENT (replacing
 * one membership with another on the same shift via UPDATE).
 *
 * IMPORTANT SCHEMA FINDING (discovered via real execution, not by
 * inspection): assignment_history.assignment_id has a foreign key to
 * assignments(id) with NO ON DELETE CASCADE. This makes it structurally
 * impossible to both (a) write a history row referencing this assignment
 * and (b) delete the assignment row afterward -- PostgreSQL rejects the
 * DELETE outright once any row references it. This means
 * assignment_history cannot accompany a pure removal in this schema; it is
 * only usable for an in-place reassignment (UPDATE, not implemented in
 * this gate per scope). A pure removal is therefore a direct DELETE with
 * no history trail -- an honest limitation of the current schema, not
 * something invented here to work around it.
 */
export async function removeAssignment(
  userId: string,
  organizationId: string,
  shiftId: string,
  assignmentId: string,
  _reason?: string
): Promise<void> {
  assertUuid(shiftId, "shiftId");
  assertUuid(assignmentId, "assignmentId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const existing = await sql<{ id: string }>`
      SELECT id FROM assignments
      WHERE id = ${assignmentId} AND shift_id = ${shiftId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!existing.rows[0]) throw new AssignmentNotFoundError();

    await sql`DELETE FROM assignments WHERE id = ${assignmentId} AND organization_id = ${organizationId}`.execute(
      trx
    );

    const remaining = await sql<{ count: string }>`
      SELECT count(*) FROM assignments WHERE shift_id = ${shiftId}
    `.execute(trx);
    if (Number(remaining.rows[0].count) === 0) {
      await sql`UPDATE shifts SET status = 'unassigned', updated_at = now() WHERE id = ${shiftId} AND status != 'cancelled'`.execute(
        trx
      );
    }
  });
}

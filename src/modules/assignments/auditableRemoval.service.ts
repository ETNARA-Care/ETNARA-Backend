import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { AssignmentNotFoundError } from "./assignments.service.js";

export class AssignmentRemovalReasonRequiredError extends Error {
  constructor() {
    super("ASSIGNMENT_REMOVAL_REASON_REQUIRED");
    this.name = "AssignmentRemovalReasonRequiredError";
  }
}

export class AssignmentHasActiveVisitError extends Error {
  constructor() {
    super("ASSIGNMENT_HAS_ACTIVE_VISIT");
    this.name = "AssignmentHasActiveVisitError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

interface RemovalSnapshot {
  id: string;
  organization_id: string;
  shift_id: string;
  organization_worker_membership_id: string;
  care_recipient_id: string | null;
  role_in_shift: string | null;
  response_status: string;
  responded_at: string | null;
  response_reason: string | null;
  created_at: string;
}

/**
 * E.1/E.2 auditable pure unassignment.
 *
 * E.2 prevents removing an assignment while that caregiver has an open visit.
 * The guard runs before the audit insert and DELETE in the same tenant transaction,
 * so a blocked removal leaves both the assignment and audit history untouched.
 */
export async function removeAssignmentAudited(
  userId: string,
  organizationId: string,
  shiftId: string,
  assignmentId: string,
  reason?: string
): Promise<void> {
  assertUuid(shiftId, "shiftId");
  assertUuid(assignmentId, "assignmentId");

  const removalReason = reason?.trim();
  if (!removalReason || removalReason.length > 500) {
    throw new AssignmentRemovalReasonRequiredError();
  }

  return withTenantContext({ userId, organizationId }, async (trx) => {
    const existing = await sql<RemovalSnapshot>`
      SELECT id, organization_id, shift_id, organization_worker_membership_id,
             care_recipient_id, role_in_shift, response_status, responded_at,
             response_reason, created_at
      FROM assignments
      WHERE id = ${assignmentId}
        AND shift_id = ${shiftId}
        AND organization_id = ${organizationId}
      LIMIT 1
      FOR UPDATE
    `.execute(trx);

    const assignment = existing.rows[0];
    if (!assignment) throw new AssignmentNotFoundError();

    const activeVisit = await sql<{ id: string }>`
      SELECT check_in.id
      FROM verification_events check_in
      WHERE check_in.organization_id = ${organizationId}
        AND check_in.shift_id = ${shiftId}
        AND check_in.organization_worker_membership_id = ${assignment.organization_worker_membership_id}
        AND check_in.event_type = 'check_in'
        AND NOT EXISTS (
          SELECT 1
          FROM verification_events check_out
          WHERE check_out.organization_id = check_in.organization_id
            AND check_out.shift_id = check_in.shift_id
            AND check_out.organization_worker_membership_id = check_in.organization_worker_membership_id
            AND check_out.event_type = 'check_out'
            AND check_out.occurred_at > check_in.occurred_at
        )
      ORDER BY check_in.occurred_at DESC
      LIMIT 1
    `.execute(trx);

    if (activeVisit.rows[0]) throw new AssignmentHasActiveVisitError();

    await sql`
      INSERT INTO assignment_removal_audit (
        organization_id,
        assignment_id,
        shift_id,
        organization_worker_membership_id,
        care_recipient_id,
        role_in_shift,
        previous_response_status,
        previous_responded_at,
        previous_response_reason,
        assignment_created_at,
        removed_by_user_id,
        removal_reason
      ) VALUES (
        ${organizationId},
        ${assignment.id},
        ${assignment.shift_id},
        ${assignment.organization_worker_membership_id},
        ${assignment.care_recipient_id},
        ${assignment.role_in_shift},
        ${assignment.response_status},
        ${assignment.responded_at},
        ${assignment.response_reason},
        ${assignment.created_at},
        ${userId},
        ${removalReason}
      )
    `.execute(trx);

    await sql`
      DELETE FROM assignments
      WHERE id = ${assignmentId}
        AND organization_id = ${organizationId}
    `.execute(trx);

    const remaining = await sql<{ count: string }>`
      SELECT count(*) FROM assignments
      WHERE shift_id = ${shiftId}
        AND organization_id = ${organizationId}
        AND response_status IN ('pending', 'accepted')
    `.execute(trx);

    if (Number(remaining.rows[0].count) === 0) {
      await sql`
        UPDATE shifts
        SET status = 'unassigned', updated_at = now()
        WHERE id = ${shiftId}
          AND organization_id = ${organizationId}
          AND status != 'cancelled'
      `.execute(trx);
    }
  });
}

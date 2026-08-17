import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { evaluateWorkerEligibility } from "../eligibility/eligibility.service.js";

export class WorkerNotLinkedError extends Error {
  constructor() {
    super("USER_HAS_NO_WORKER_PROFILE");
    this.name = "WorkerNotLinkedError";
  }
}
export class ShiftNotFoundError extends Error {
  constructor() {
    super("SHIFT_NOT_FOUND");
    this.name = "ShiftNotFoundError";
  }
}
export class ShiftCancelledError extends Error {
  constructor() {
    super("SHIFT_CANCELLED");
    this.name = "ShiftCancelledError";
  }
}
export class ShiftCompletedError extends Error {
  constructor() {
    super("SHIFT_COMPLETED");
    this.name = "ShiftCompletedError";
  }
}
export class NoAssignmentError extends Error {
  constructor() {
    super("NO_ASSIGNMENT_FOR_THIS_WORKER");
    this.name = "NoAssignmentError";
  }
}
export class WorkerNotEligibleError extends Error {
  constructor(status: string) {
    super(`WORKER_NOT_ELIGIBLE_${status.toUpperCase()}`);
    this.name = "WorkerNotEligibleError";
  }
}
export class InvalidVerificationMethodError extends Error {
  constructor() {
    super("INVALID_VERIFICATION_METHOD");
    this.name = "InvalidVerificationMethodError";
  }
}
export class AlreadyCheckedInError extends Error {
  constructor() {
    super("ALREADY_CHECKED_IN");
    this.name = "AlreadyCheckedInError";
  }
}
export class NoActiveCheckInError extends Error {
  constructor() {
    super("NO_ACTIVE_CHECK_IN");
    this.name = "NoActiveCheckInError";
  }
}
export class NotOrgManagerError extends Error {
  constructor() {
    super("SUPERVISOR_OVERRIDE_REQUIRES_ORG_MANAGER");
    this.name = "NotOrgManagerError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const checkInSchema = z.object({
  verificationMethodCode: z.string().min(1),
  actorContext: z.string().optional(),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
});
export type CheckInInput = z.infer<typeof checkInSchema>;

export const checkOutSchema = z.object({
  actorContext: z.string().optional(),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
});
export type CheckOutInput = z.infer<typeof checkOutSchema>;

interface VerificationEventRow {
  id: string;
  organization_id: string;
  shift_id: string;
  organization_worker_membership_id: string;
  verification_method_id: string;
  event_type: "check_in" | "check_out";
  occurred_at: string;
  actor_user_id: string | null;
  actor_context: string | null;
  location_lat: string | null;
  location_lng: string | null;
}

async function resolveWorkerForUser(trx: unknown, userId: string): Promise<string> {
  const result = await sql<{ id: string }>`SELECT id FROM workers WHERE user_id = ${userId} LIMIT 1`.execute(
    trx as never
  );
  if (!result.rows[0]) throw new WorkerNotLinkedError();
  return result.rows[0].id;
}

async function resolveMembership(trx: unknown, workerId: string, organizationId: string) {
  const result = await sql<{ id: string; status: string }>`
    SELECT id, status FROM organization_worker_memberships
    WHERE worker_id = ${workerId} AND organization_id = ${organizationId}
    LIMIT 1
  `.execute(trx as never);
  return result.rows[0] ?? null;
}

async function resolveVerificationMethodId(trx: unknown, code: string): Promise<string> {
  const result = await sql<{ id: string }>`SELECT id FROM verification_methods WHERE code = ${code} LIMIT 1`.execute(
    trx as never
  );
  if (!result.rows[0]) throw new InvalidVerificationMethodError();
  return result.rows[0].id;
}

async function findActiveCheckIn(trx: unknown, shiftId: string, membershipId: string) {
  const result = await sql<VerificationEventRow>`
    SELECT * FROM verification_events
    WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membershipId} AND event_type = 'check_in'
    ORDER BY occurred_at DESC
    LIMIT 1
  `.execute(trx as never);
  const lastCheckIn = result.rows[0];
  if (!lastCheckIn) return null;

  const laterCheckOut = await sql<{ id: string }>`
    SELECT id FROM verification_events
    WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membershipId} AND event_type = 'check_out'
      AND occurred_at > ${lastCheckIn.occurred_at}
    LIMIT 1
  `.execute(trx as never);
  return laterCheckOut.rows[0] ? null : lastCheckIn;
}

export async function checkIn(
  userId: string,
  organizationId: string,
  shiftId: string,
  input: CheckInInput
): Promise<VerificationEventRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerId = await resolveWorkerForUser(trx, userId);

    const membership = await resolveMembership(trx, workerId, organizationId);
    if (!membership) throw new NoAssignmentError();
    if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");

    const shiftRow = await sql<{ id: string; status: string }>`
      SELECT id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    const shift = shiftRow.rows[0];
    if (!shift) throw new ShiftNotFoundError();
    if (shift.status === "cancelled") throw new ShiftCancelledError();
    if (shift.status === "completed") throw new ShiftCompletedError();

    const assignmentRow = await sql<{ id: string }>`
      SELECT id FROM assignments
      WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membership.id} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!assignmentRow.rows[0]) throw new NoAssignmentError();

    const eligibility = await evaluateWorkerEligibility(userId, organizationId, membership.id);
    if (eligibility.eligibilityStatus !== "eligible") {
      throw new WorkerNotEligibleError(eligibility.eligibilityStatus);
    }

    const methodId = await resolveVerificationMethodId(trx, input.verificationMethodCode);

    const active = await findActiveCheckIn(trx, shiftId, membership.id);
    if (active) throw new AlreadyCheckedInError();

    const result = await sql<VerificationEventRow>`
      INSERT INTO verification_events (
        organization_id, shift_id, organization_worker_membership_id, verification_method_id,
        event_type, actor_user_id, actor_context, location_lat, location_lng
      ) VALUES (
        ${organizationId}, ${shiftId}, ${membership.id}, ${methodId},
        'check_in', ${userId}, ${input.actorContext ?? null}, ${input.locationLat ?? null}, ${input.locationLng ?? null}
      )
      RETURNING *
    `.execute(trx);

    await sql`UPDATE shifts SET status = 'in_progress', updated_at = now() WHERE id = ${shiftId} AND status != 'cancelled'`.execute(
      trx
    );

    return result.rows[0];
  });
}

/**
 * DESIGN NOTE (corrected after real testing, not assumed -- section
 * 21/43/51): the application layer here does NOT re-validate that an
 * `assignments` row still exists for (shift, membership) on checkout --
 * only checkIn does. HOWEVER, this intention is superseded by RLS:
 * shifts_worker_assigned_only (018) requires a LIVE assignment for a plain
 * worker's shift to even be SELECT-visible. So in practice, if an admin
 * removes a worker's assignment while their check-in is still active, that
 * worker loses visibility of the shift entirely (RLS) and CANNOT
 * self-service checkout -- confirmed by real execution against Postgres,
 * not assumed. This is the correct, RLS-enforced outcome (RLS is the last
 * line of defense and wins over any application-layer intention), and is
 * documented here rather than silently "fixed" by weakening RLS. Closing
 * an orphaned open visit in this scenario requires org-manager authority
 * (who retains full-tenant shift visibility regardless of assignment) --
 * e.g. via supervisorOverrideCheckEvent, or by temporarily restoring the
 * assignment.
 */
export async function checkOut(
  userId: string,
  organizationId: string,
  shiftId: string,
  input: CheckOutInput
): Promise<VerificationEventRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerId = await resolveWorkerForUser(trx, userId);
    const membership = await resolveMembership(trx, workerId, organizationId);
    if (!membership) throw new NoAssignmentError();

    const shiftRow = await sql<{ id: string; status: string }>`
      SELECT id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!shiftRow.rows[0]) throw new ShiftNotFoundError();

    const active = await findActiveCheckIn(trx, shiftId, membership.id);
    if (!active) throw new NoActiveCheckInError();

    const methodId = active.verification_method_id;

    const result = await sql<VerificationEventRow>`
      INSERT INTO verification_events (
        organization_id, shift_id, organization_worker_membership_id, verification_method_id,
        event_type, actor_user_id, actor_context, location_lat, location_lng
      ) VALUES (
        ${organizationId}, ${shiftId}, ${membership.id}, ${methodId},
        'check_out', ${userId}, ${input.actorContext ?? null}, ${input.locationLat ?? null}, ${input.locationLng ?? null}
      )
      RETURNING *
    `.execute(trx);

    const stillActive = await sql<{ id: string }>`
      SELECT ve1.id FROM verification_events ve1
      WHERE ve1.shift_id = ${shiftId} AND ve1.event_type = 'check_in'
        AND NOT EXISTS (
          SELECT 1 FROM verification_events ve2
          WHERE ve2.shift_id = ve1.shift_id
            AND ve2.organization_worker_membership_id = ve1.organization_worker_membership_id
            AND ve2.event_type = 'check_out'
            AND ve2.occurred_at > ve1.occurred_at
        )
      LIMIT 1
    `.execute(trx);
    if (!stillActive.rows[0]) {
      await sql`UPDATE shifts SET status = 'completed', updated_at = now() WHERE id = ${shiftId} AND status = 'in_progress'`.execute(
        trx
      );
    }

    return result.rows[0];
  });
}

export interface VerificationSummary {
  shiftId: string;
  events: Array<{
    id: string;
    eventType: string;
    occurredAt: string;
    methodCode: string;
    membershipId: string;
  }>;
  status: "not_started" | "in_progress" | "completed";
}

export async function getVerification(
  userId: string,
  organizationId: string,
  shiftId: string
): Promise<VerificationSummary> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const shiftRow = await sql<{ id: string }>`
      SELECT id FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!shiftRow.rows[0]) throw new ShiftNotFoundError();

    const result = await sql<{
      id: string;
      event_type: string;
      occurred_at: string;
      organization_worker_membership_id: string;
      method_code: string;
    }>`
      SELECT ve.id, ve.event_type, ve.occurred_at, ve.organization_worker_membership_id, vm.code as method_code
      FROM verification_events ve
      JOIN verification_methods vm ON vm.id = ve.verification_method_id
      WHERE ve.shift_id = ${shiftId}
      ORDER BY ve.occurred_at
    `.execute(trx);

    const events = result.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      methodCode: r.method_code,
      membershipId: r.organization_worker_membership_id,
    }));

    let status: VerificationSummary["status"] = "not_started";
    if (events.some((e) => e.eventType === "check_in")) status = "in_progress";
    const byMembership = new Map<string, typeof events>();
    for (const e of events) {
      if (!byMembership.has(e.membershipId)) byMembership.set(e.membershipId, []);
      byMembership.get(e.membershipId)!.push(e);
    }
    if (byMembership.size > 0) {
      const allClosed = Array.from(byMembership.values()).every((list) => {
        const lastCheckIn = [...list].reverse().find((e) => e.eventType === "check_in");
        if (!lastCheckIn) return true;
        return list.some((e) => e.eventType === "check_out" && e.occurredAt > lastCheckIn.occurredAt);
      });
      if (allClosed) status = "completed";
    }

    return { shiftId, events, status };
  });
}

export const supervisorOverrideSchema = z.object({
  organizationWorkerMembershipId: z.string().uuid(),
  eventType: z.enum(["check_in", "check_out"]),
  reason: z.string().min(1),
});
export type SupervisorOverrideInput = z.infer<typeof supervisorOverrideSchema>;

export async function supervisorOverrideCheckEvent(
  supervisorUserId: string,
  organizationId: string,
  shiftId: string,
  input: SupervisorOverrideInput
): Promise<VerificationEventRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId: supervisorUserId, organizationId }, async (trx) => {
    const managerCheck = await sql<{ exists: boolean }>`SELECT app_is_org_manager() as exists`.execute(trx);
    if (!managerCheck.rows[0]?.exists) throw new NotOrgManagerError();

    const membershipRow = await sql<{ id: string }>`
      SELECT id FROM organization_worker_memberships
      WHERE id = ${input.organizationWorkerMembershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!membershipRow.rows[0]) throw new NoAssignmentError();

    const shiftRow = await sql<{ id: string; status: string }>`
      SELECT id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!shiftRow.rows[0]) throw new ShiftNotFoundError();

    const methodId = await resolveVerificationMethodId(trx, "SUPERVISOR_OVERRIDE");

    const eventResult = await sql<VerificationEventRow>`
      INSERT INTO verification_events (
        organization_id, shift_id, organization_worker_membership_id, verification_method_id,
        event_type, actor_user_id, actor_context
      ) VALUES (
        ${organizationId}, ${shiftId}, ${input.organizationWorkerMembershipId}, ${methodId},
        ${input.eventType}, ${supervisorUserId}, 'supervisor_override'
      )
      RETURNING *
    `.execute(trx);

    await sql`
      INSERT INTO verification_overrides (verification_event_id, organization_id, authorized_by_user_id, reason)
      VALUES (${eventResult.rows[0].id}, ${organizationId}, ${supervisorUserId}, ${input.reason})
    `.execute(trx);

    return eventResult.rows[0];
  });
}

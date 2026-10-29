import { sql } from "kysely";
import { isOrgManager, ownWorkerMembershipId } from "../../security/roleGuards.js";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { evaluateWorkerEligibility } from "../eligibility/eligibility.service.js";
import { recordTimesheetFromCheckout } from "../timesheets/timesheets.service.js";

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
export class AssignmentNotAcceptedError extends Error {
  constructor() {
    super("ASSIGNMENT_NOT_ACCEPTED");
    this.name = "AssignmentNotAcceptedError";
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
export class OccurredAtOutOfRangeError extends Error {
  constructor() {
    super("OCCURRED_AT_OUT_OF_RANGE");
    this.name = "OccurredAtOutOfRangeError";
  }
}

/**
 * «Comenzar turno» is refused once the scheduled end has passed (same limit as
 * «Llegué», 107). The time checked is the real one: the device time of an offline
 * record (already validated) or now(), so a check-in made in time and synced later
 * still counts. A visit that really happened but was never started is recorded by
 * the agency (supervisor override, audited), never by the caregiver days later.
 * Before the start, the portal only offers «Comenzar» from 2 h before; the server
 * does not enforce that side yet (see the B5 report: test fixtures check in early).
 */
export class CheckInOutsideWindowError extends Error {
  constructor() {
    super("CHECK_IN_OUTSIDE_WINDOW");
    this.name = "CheckInOutsideWindowError";
  }
}

export function checkInAfterScheduledEnd(at: number, scheduledEnd: string | Date): boolean {
  return at > new Date(scheduledEnd).getTime();
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

// Phase 12.4: a check-in/out recorded on the device without signal carries
// its own id (so a retry never duplicates it) and the real time it happened.
const offlineFields = {
  clientEventId: z.string().uuid().optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  /** The device stored it because there was no signal. */
  recordedOffline: z.boolean().optional(),
};

// Gate 6 data minimization: locationLat/locationLng are still accepted for old
// clients but ignored -- raw device coordinates are never stored. Proximity is
// checked once, with consent, by POST .../arrival (verification.arrival.ts).
export const checkInSchema = z.object({
  verificationMethodCode: z.string().min(1),
  actorContext: z.string().optional(),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
  ...offlineFields,
});
export type CheckInInput = z.infer<typeof checkInSchema>;

export const checkOutSchema = z.object({
  actorContext: z.string().optional(),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
  ...offlineFields,
});

/** Tolerated device clock drift ahead of the server. */
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Records older than this are not accepted (the device deletes them too). */
const MAX_OFFLINE_AGE_MS = 7 * 24 * 3600 * 1000;
/** Arriving later than this after it happened counts as "sin conexión". */
const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Validated time for a device-supplied record, or null to use now(). It is
 * marked "sin conexión" when the device says it waited for signal, or when it
 * arrived late regardless of what the device says.
 */
export function resolveOccurredAt(occurredAt: string | undefined, notBefore?: string, deviceOffline = false): { at: string | null; offline: boolean } {
  if (!occurredAt) return { at: null, offline: deviceOffline };
  const occurred = new Date(occurredAt).getTime();
  const now = Date.now();
  if (Number.isNaN(occurred)) throw new OccurredAtOutOfRangeError();
  if (occurred > now + MAX_CLOCK_SKEW_MS) throw new OccurredAtOutOfRangeError();
  if (occurred < now - MAX_OFFLINE_AGE_MS) throw new OccurredAtOutOfRangeError();
  if (notBefore && occurred <= new Date(notBefore).getTime()) throw new OccurredAtOutOfRangeError();
  return { at: new Date(Math.min(occurred, now)).toISOString(), offline: deviceOffline || now - occurred > OFFLINE_THRESHOLD_MS };
}

/**
 * The caller's own record by its device id. Definer helper (087): a retry may
 * arrive after the visit closed, when the caregiver can no longer read it.
 * Matching on organization + membership keeps ids from colliding or leaking.
 */
async function findByClientEventId(trx: unknown, organizationId: string, membershipId: string, clientEventId: string, eventType: string) {
  const result = await sql<VerificationEventRow>`
    SELECT f.id, ${organizationId}::uuid AS organization_id, f.shift_id, ${membershipId}::uuid AS organization_worker_membership_id,
           f.event_type, f.occurred_at, f.recorded_offline, f.client_event_id
    FROM app_find_own_verification_event(${clientEventId}::uuid, ${eventType}) f
  `.execute(trx as never);
  return result.rows[0] ?? null;
}
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
  client_event_id: string | null;
  recorded_offline: boolean;
  /** Not a column: true when a retry returned the record already stored. */
  replayed?: boolean;
}

export async function resolveWorkerForUser(trx: unknown, userId: string): Promise<string> {
  const result = await sql<{ id: string }>`SELECT id FROM workers WHERE user_id = ${userId} LIMIT 1`.execute(
    trx as never
  );
  if (!result.rows[0]) throw new WorkerNotLinkedError();
  return result.rows[0].id;
}

export async function resolveMembership(trx: unknown, workerId: string, organizationId: string) {
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

async function notifyShiftStatus(
  trx: unknown,
  actorUserId: string,
  organizationId: string,
  shiftId: string,
  notificationType: "SHIFT_STARTED" | "SHIFT_COMPLETED"
): Promise<void> {
  await sql`
    WITH shift_recipients AS (
      SELECT DISTINCT cr.id AS care_recipient_id
      FROM shifts s
      JOIN care_recipients cr
        ON cr.organization_id = s.organization_id
       AND (
         cr.id = s.care_recipient_id
         OR (s.care_recipient_id IS NULL AND s.room_id IS NOT NULL AND cr.room_id = s.room_id)
       )
      WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId}
    ), targets AS (
      SELECT DISTINCT om.user_id, sr.care_recipient_id
      FROM shift_recipients sr
      JOIN organization_memberships om
        ON om.organization_id = ${organizationId} AND om.status = 'active'
      JOIN user_roles ur ON ur.organization_membership_id = om.id
      JOIN roles r ON r.id = ur.role_id AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')

      UNION

      SELECT DISTINCT fr.user_id, sr.care_recipient_id
      FROM shift_recipients sr
      JOIN family_relationships fr
        ON fr.organization_id = ${organizationId}
       AND fr.care_recipient_id = sr.care_recipient_id
       AND fr.status = 'active'
       AND fr.can_receive_notifications = true
      WHERE EXISTS (
        SELECT 1
        FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
        WHERE om.user_id = fr.user_id
          AND om.organization_id = ${organizationId}
          AND om.status = 'active'
      )
    )
    INSERT INTO notifications (
      user_id, organization_id, notification_type, related_entity_type,
      related_entity_id, care_recipient_id, channel, status, sent_at
    )
    SELECT
      targets.user_id, ${organizationId}, ${notificationType}, 'shift',
      ${shiftId}, targets.care_recipient_id, 'in_app', 'sent', now()
    FROM targets
    WHERE targets.user_id <> ${actorUserId}
      AND NOT EXISTS (
        SELECT 1
        FROM notifications existing
        WHERE existing.user_id = targets.user_id
          AND existing.organization_id = ${organizationId}
          AND existing.notification_type = ${notificationType}
          AND existing.related_entity_type = 'shift'
          AND existing.related_entity_id = ${shiftId}
          AND existing.care_recipient_id = targets.care_recipient_id
      )
  `.execute(trx as never);
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

    if (input.clientEventId) {
      const existing = await findByClientEventId(trx, organizationId, membership.id, input.clientEventId, "check_in");
      if (existing) return { ...existing, replayed: true };
    }
    const when = resolveOccurredAt(input.occurredAt, undefined, input.recordedOffline === true);

    const shiftRow = await sql<{ id: string; status: string; scheduled_end: Date }>`
      SELECT id, status, scheduled_end FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    const shift = shiftRow.rows[0];
    if (!shift) throw new ShiftNotFoundError();
    if (shift.status === "cancelled") throw new ShiftCancelledError();
    if (shift.status === "completed") throw new ShiftCompletedError();
    if (checkInAfterScheduledEnd(when.at ? new Date(when.at).getTime() : Date.now(), shift.scheduled_end)) {
      throw new CheckInOutsideWindowError();
    }

    const assignmentRow = await sql<{ id: string; response_status: string }>`
      SELECT id, response_status FROM assignments
      WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membership.id} AND organization_id = ${organizationId}
        AND response_status IN ('pending', 'accepted')
      LIMIT 1
    `.execute(trx);
    if (!assignmentRow.rows[0]) throw new NoAssignmentError();
    if (assignmentRow.rows[0].response_status !== "accepted") throw new AssignmentNotAcceptedError();

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
        event_type, actor_user_id, actor_context, location_lat, location_lng,
        client_event_id, recorded_offline, occurred_at
      ) VALUES (
        ${organizationId}, ${shiftId}, ${membership.id}, ${methodId},
        'check_in', ${userId}, ${input.actorContext ?? null}, null, null,
        ${input.clientEventId ?? null}, ${when.offline}, COALESCE(${when.at}::timestamptz, now())
      )
      ON CONFLICT (organization_id, organization_worker_membership_id, client_event_id)
        WHERE client_event_id IS NOT NULL
        DO NOTHING
      RETURNING *
    `.execute(trx);
    if (!result.rows[0] && input.clientEventId) {
      // A concurrent retry stored the same record between our lookup and insert.
      const existing = await findByClientEventId(trx, organizationId, membership.id, input.clientEventId, "check_in");
      if (existing) return { ...existing, replayed: true };
      throw new AlreadyCheckedInError();
    }

    await sql`UPDATE shifts SET status = 'in_progress', updated_at = now() WHERE id = ${shiftId} AND status != 'cancelled'`.execute(
      trx
    );

    await notifyShiftStatus(trx, userId, organizationId, shiftId, "SHIFT_STARTED");

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

    if (input.clientEventId) {
      const existing = await findByClientEventId(trx, organizationId, membership.id, input.clientEventId, "check_out");
      if (existing) return { ...existing, replayed: true };
    }

    const shiftRow = await sql<{ id: string; status: string }>`
      SELECT id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!shiftRow.rows[0]) throw new ShiftNotFoundError();

    const active = await findActiveCheckIn(trx, shiftId, membership.id);
    if (!active) throw new NoActiveCheckInError();
    const when = resolveOccurredAt(input.occurredAt, active.occurred_at, input.recordedOffline === true);

    const methodId = active.verification_method_id;

    const result = await sql<VerificationEventRow>`
      INSERT INTO verification_events (
        organization_id, shift_id, organization_worker_membership_id, verification_method_id,
        event_type, actor_user_id, actor_context, location_lat, location_lng,
        client_event_id, recorded_offline, occurred_at
      ) VALUES (
        ${organizationId}, ${shiftId}, ${membership.id}, ${methodId},
        'check_out', ${userId}, ${input.actorContext ?? null}, null, null,
        ${input.clientEventId ?? null}, ${when.offline}, COALESCE(${when.at}::timestamptz, now())
      )
      ON CONFLICT (organization_id, organization_worker_membership_id, client_event_id)
        WHERE client_event_id IS NOT NULL
        DO NOTHING
      RETURNING *
    `.execute(trx);
    if (!result.rows[0] && input.clientEventId) {
      // A concurrent retry stored the same record between our lookup and insert.
      const existing = await findByClientEventId(trx, organizationId, membership.id, input.clientEventId, "check_out");
      if (existing) return { ...existing, replayed: true };
      throw new AlreadyCheckedInError();
    }

    await recordTimesheetFromCheckout(trx, {
      actorUserId: userId,
      organizationId,
      shiftId,
      membershipId: membership.id,
      checkInAt: active.occurred_at,
      checkOutAt: result.rows[0].occurred_at,
    });

    // Definer helper (086): this caregiver cannot read co-workers' check-ins.
    const stillActive = await sql<{ open: boolean }>`
      SELECT app_shift_has_open_check_in(${shiftId}) AS open
    `.execute(trx);
    if (!stillActive.rows[0]?.open) {
      // Notify BEFORE completing: once the shift is completed the caregiver can no
      // longer read it (076), so the recipients query would come back empty and
      // nobody (agency or family) would learn the service finished. Same transaction.
      await notifyShiftStatus(trx, userId, organizationId, shiftId, "SHIFT_COMPLETED");
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
    recordedOffline: boolean;
  }>;
  status: "not_started" | "in_progress" | "completed";
  /** Gate 6: "Llegué" records (result only, never coordinates). */
  arrivals: Array<{ membershipId: string; occurredAt: string; proximity: string; distanceM: number | null;
    needsReview: boolean; reviewedAt: string | null; reviewNote: string | null; recordedOffline: boolean }>;
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
    // Managers see every caregiver's events. A caregiver who is (or was) assigned
    // to this shift sees only her own events and arrivals -- also after
    // check-out, so the completed visit still opens in her app. Family and other
    // caregivers get nothing here (the family portal has its own summary).
    // Same row rule as RLS verification_events_worker_own_assignment and
    // shift_arrivals_worker_read (018, 101).
    const managerView = await isOrgManager(trx);
    const ownMembership = managerView ? null : await ownWorkerMembershipId(trx);
    if (!managerView) {
      const assigned = ownMembership
        ? (await sql<{ ok: boolean }>`
            SELECT EXISTS (SELECT 1 FROM assignments a
              WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId}
                AND a.organization_worker_membership_id = ${ownMembership}) AS ok`.execute(trx)).rows[0]?.ok === true
        : false;
      if (!assigned) throw new ShiftNotFoundError();
    }
    const ownOnly = managerView ? sql`TRUE` : sql`organization_worker_membership_id = ${ownMembership}`;

    const result = await sql<{
      id: string;
      event_type: string;
      occurred_at: string;
      organization_worker_membership_id: string;
      method_code: string;
      recorded_offline: boolean;
    }>`
      SELECT ve.id, ve.event_type, ve.occurred_at, ve.organization_worker_membership_id, vm.code as method_code, ve.recorded_offline
      FROM verification_events ve
      JOIN verification_methods vm ON vm.id = ve.verification_method_id
      WHERE ve.shift_id = ${shiftId} AND ve.organization_id = ${organizationId}
        AND ${managerView ? sql`TRUE` : sql`ve.organization_worker_membership_id = ${ownMembership}`}
      ORDER BY ve.occurred_at
    `.execute(trx);

    const events = result.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      methodCode: r.method_code,
      membershipId: r.organization_worker_membership_id,
      recordedOffline: r.recorded_offline,
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

    // The review note is the agency's: caregivers see whether it was reviewed, not what was written.
    const arrivals = (await sql<{ organization_worker_membership_id: string; occurred_at: string; proximity: string;
      distance_m: number | null; needs_review: boolean; reviewed_at: string | null; review_note: string | null; recorded_offline: boolean }>`
      SELECT organization_worker_membership_id, occurred_at, proximity, distance_m, needs_review, reviewed_at, review_note, recorded_offline
      FROM shift_arrivals WHERE shift_id = ${shiftId} AND organization_id = ${organizationId} AND ${ownOnly}
      ORDER BY occurred_at
    `.execute(trx)).rows.map((a) => ({
      membershipId: a.organization_worker_membership_id, occurredAt: a.occurred_at, proximity: a.proximity,
      distanceM: a.distance_m, needsReview: a.needs_review, reviewedAt: a.reviewed_at, reviewNote: managerView ? a.review_note : null,
      recordedOffline: a.recorded_offline,
    }));

    return { shiftId, events, status, arrivals };
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

    const activeCheckIn = input.eventType === "check_out"
      ? await findActiveCheckIn(trx, shiftId, input.organizationWorkerMembershipId)
      : null;

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

    if (input.eventType === "check_out" && activeCheckIn) {
      await recordTimesheetFromCheckout(trx, {
        actorUserId: supervisorUserId,
        organizationId,
        shiftId,
        membershipId: input.organizationWorkerMembershipId,
        checkInAt: activeCheckIn.occurred_at,
        checkOutAt: eventResult.rows[0].occurred_at,
      });
    }

    return eventResult.rows[0];
  });
}

/**
 * 154 — Shifts that ended without service: legitimate resolution of «Turno terminado sin cubrir»
 * and «Turno terminado sin registro de entrada» in the operations center.
 *
 *  - «Cerrar como no cubierto» / «Cerrar: servicio no prestado»: one immutable closure
 *    (who, when, outcome, reason, mandatory note) written by app_close_shift_without_service().
 *    The shift row is never touched; no verification event and no timesheet are created, so a
 *    closed shift never counts as a service and is never billable.
 *  - «El servicio sí ocurrió»: the exceptional, audited correction of an omitted check-in
 *    (recordOmittedVisitCorrection). It keeps the existing verification_overrides mechanism:
 *    events labelled SUPERVISOR_OVERRIDE at the real time of the correction (never the visit time,
 *    never invented), a mandatory reason, and a timesheet left «pending» for an ORGANIZATION_ADMIN
 *    to enter the real minutes with a justification. Nothing is billed until then.
 */
import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { recordTimesheetFromCheckout } from "../timesheets/timesheets.service.js";

export const CLOSURE_REASONS = [
  "no_caregiver_available",
  "family_cancelled",
  "recipient_absent_or_hospitalized",
  "caregiver_no_show",
  "other",
] as const;

export const closeShiftSchema = z.object({
  reasonCode: z.enum(CLOSURE_REASONS),
  note: z.string().trim().min(10).max(2000),
});
export const omittedVisitCorrectionSchema = z.object({
  organizationWorkerMembershipId: z.string().uuid(),
  reason: z.string().trim().min(20).max(2000),
});
export const listClosuresSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

export class ShiftClosureError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ShiftClosureError";
  }
}

const DB_CODES: Record<string, number> = {
  SHIFT_CLOSURE_FORBIDDEN: 403,
  SHIFT_CLOSURE_NOT_FOUND: 404,
  SHIFT_CLOSURE_NOT_ENDED: 409,
  SHIFT_CLOSURE_NOT_CLOSABLE: 409,
  SHIFT_CLOSURE_HAS_CHECK_IN: 409,
  SHIFT_CLOSURE_ALREADY_CLOSED: 409,
  SHIFT_CLOSURE_REASON_INVALID: 400,
  SHIFT_CLOSURE_NOTE_REQUIRED: 400,
};

function assertUuid(value: string, label: string) {
  if (!z.string().uuid().safeParse(value).success) throw new InvalidTenantContextError(`${label} must be a valid UUID`);
}

async function assertManager(trx: unknown) {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx as never);
  if (!r.rows[0]?.ok) throw new ShiftClosureError("REQUIRES_ORG_MANAGER", 403);
}

export interface ShiftClosure {
  id: string;
  shiftId: string;
  outcome: "not_covered" | "not_performed";
  reasonCode: (typeof CLOSURE_REASONS)[number];
  note: string;
  closedAt: string;
  closedByEmail: string | null;
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

type ClosureRow = { id: string; shift_id: string; outcome: ShiftClosure["outcome"]; reason_code: ShiftClosure["reasonCode"]; note: string; closed_at: string; closed_by_email: string | null };
const toClosure = (r: ClosureRow): ShiftClosure => ({
  id: r.id, shiftId: r.shift_id, outcome: r.outcome, reasonCode: r.reason_code, note: r.note,
  closedAt: iso(r.closed_at)!, closedByEmail: r.closed_by_email,
});

async function readClosure(trx: unknown, organizationId: string, shiftId: string): Promise<ShiftClosure | null> {
  const r = (await sql<ClosureRow>`
    SELECT c.id, c.shift_id, c.outcome, c.reason_code, c.note, c.closed_at, u.email AS closed_by_email
    FROM shift_attention_closures c LEFT JOIN users u ON u.id = c.closed_by_user_id
    WHERE c.shift_id = ${shiftId} AND c.organization_id = ${organizationId}
  `.execute(trx as never)).rows[0];
  return r ? toClosure(r) : null;
}

/** POST /shifts/:shiftId/close-without-service */
export async function closeShiftWithoutService(
  userId: string, organizationId: string, shiftId: string, input: z.infer<typeof closeShiftSchema>,
): Promise<ShiftClosure> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    await sql`SELECT app_close_shift_without_service(${shiftId}::uuid, ${input.reasonCode}, ${input.note})`
      .execute(trx)
      .catch((error: { message?: string }) => {
        const code = /SHIFT_CLOSURE_[A-Z_]+/.exec(error?.message ?? "")?.[0];
        if (code && DB_CODES[code]) throw new ShiftClosureError(code, DB_CODES[code]);
        throw error;
      });
    return (await readClosure(trx, organizationId, shiftId))!;
  });
}

export interface ShiftAttention {
  shiftId: string;
  ended: boolean;
  status: string;
  hasCheckIn: boolean;
  /** not_covered: nobody accepted the shift; not_performed: a caregiver accepted it. */
  outcome: ShiftClosure["outcome"];
  canClose: boolean;
  canCorrectOmittedVisit: boolean;
  allowedReasons: ShiftClosure["reasonCode"][];
  acceptedCaregivers: { membershipId: string; name: string; checkedIn: boolean }[];
  closure: ShiftClosure | null;
  /** A real check-in arrived after the closure (e.g. an offline check-in made in time). */
  closureContradicted: boolean;
}

/** GET /shifts/:shiftId/attention — what the agency can legitimately do with an ended shift. */
export async function getShiftAttention(userId: string, organizationId: string, shiftId: string): Promise<ShiftAttention> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const shift = (await sql<{ status: string; ended: boolean; has_check_in: boolean }>`
      SELECT s.status, s.scheduled_end <= now() AS ended, app_shift_has_check_in(s.id) AS has_check_in
      FROM shifts s WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId}
    `.execute(trx)).rows[0];
    if (!shift) throw new ShiftClosureError("SHIFT_NOT_FOUND", 404);
    const caregivers = (await sql<{ membership_id: string; name: string | null; checked_in: boolean }>`
      SELECT a.organization_worker_membership_id AS membership_id, w.display_name AS name,
        EXISTS (SELECT 1 FROM verification_events v WHERE v.shift_id = a.shift_id
                AND v.organization_worker_membership_id = a.organization_worker_membership_id AND v.event_type = 'check_in') AS checked_in
      FROM assignments a
      JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
      JOIN workers w ON w.id = m.worker_id
      WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId} AND a.response_status = 'accepted'
      ORDER BY w.display_name
    `.execute(trx)).rows;
    const closure = await readClosure(trx, organizationId, shiftId);
    const outcome: ShiftClosure["outcome"] = caregivers.length ? "not_performed" : "not_covered";
    const open = shift.ended && ["unassigned", "confirmed"].includes(shift.status) && !closure;
    return {
      shiftId,
      ended: shift.ended,
      status: shift.status,
      hasCheckIn: shift.has_check_in,
      outcome,
      canClose: open && !shift.has_check_in,
      canCorrectOmittedVisit: open && caregivers.some((c) => !c.checked_in),
      allowedReasons: CLOSURE_REASONS.filter((r) => (outcome === "not_covered" ? r !== "caregiver_no_show" : r !== "no_caregiver_available")),
      acceptedCaregivers: caregivers.map((c) => ({ membershipId: c.membership_id, name: c.name || "Cuidador", checkedIn: c.checked_in })),
      closure,
      closureContradicted: Boolean(closure) && shift.has_check_in,
    };
  });
}

export interface ShiftClosureHistoryItem extends ShiftClosure {
  scheduledStart: string;
  scheduledEnd: string;
  recipientName: string | null;
  contradicted: boolean;
}

/** GET /shift-closures — history of shifts closed without service, newest first. */
export async function listShiftClosures(
  userId: string, organizationId: string, input: z.infer<typeof listClosuresSchema>,
): Promise<{ closures: ShiftClosureHistoryItem[] }> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const rows = (await sql<ClosureRow & { scheduled_start: string; scheduled_end: string; recipient_name: string | null; contradicted: boolean }>`
      SELECT c.id, c.shift_id, c.outcome, c.reason_code, c.note, c.closed_at, u.email AS closed_by_email,
        s.scheduled_start, s.scheduled_end,
        COALESCE(NULLIF(trim(cr.preferred_name), ''), NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '')) AS recipient_name,
        app_shift_has_check_in(s.id) AS contradicted
      FROM shift_attention_closures c
      JOIN shifts s ON s.id = c.shift_id AND s.organization_id = c.organization_id
      LEFT JOIN care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
      LEFT JOIN users u ON u.id = c.closed_by_user_id
      WHERE c.organization_id = ${organizationId}
        AND (${input.before ?? null}::timestamptz IS NULL OR c.closed_at < ${input.before ?? null}::timestamptz)
      ORDER BY c.closed_at DESC
      LIMIT ${input.limit}
    `.execute(trx)).rows;
    return {
      closures: rows.map((r) => ({
        ...toClosure(r), scheduledStart: iso(r.scheduled_start)!, scheduledEnd: iso(r.scheduled_end)!,
        recipientName: r.recipient_name, contradicted: r.contradicted,
      })),
    };
  });
}

/**
 * POST /shifts/:shiftId/verification/omitted-visit-correction — «El servicio sí ocurrió».
 * Only for a shift that already ended, still not started in the system, not closed without
 * service, and only for a caregiver who had accepted it and has no check-in. Records, in one
 * transaction, a check-in and a check-out labelled SUPERVISOR_OVERRIDE at the real time of the
 * correction (clock_timestamp: never the visit time) with the reason in verification_overrides,
 * and a «pending» timesheet. The database audits each override (154).
 */
export async function recordOmittedVisitCorrection(
  userId: string, organizationId: string, shiftId: string, input: z.infer<typeof omittedVisitCorrectionSchema>,
) {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const shift = (await sql<{ status: string; ended: boolean }>`
      SELECT status, scheduled_end <= now() AS ended FROM shifts
      WHERE id = ${shiftId} AND organization_id = ${organizationId} FOR UPDATE
    `.execute(trx)).rows[0];
    if (!shift) throw new ShiftClosureError("SHIFT_NOT_FOUND", 404);
    if (!shift.ended) throw new ShiftClosureError("SHIFT_NOT_ENDED", 409);
    if (!["unassigned", "confirmed"].includes(shift.status)) throw new ShiftClosureError("SHIFT_NOT_CORRECTABLE", 409);
    if (await readClosure(trx, organizationId, shiftId)) throw new ShiftClosureError("SHIFT_CLOSED_WITHOUT_SERVICE", 409);
    const membershipId = input.organizationWorkerMembershipId;
    const accepted = (await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM assignments WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
        AND organization_worker_membership_id = ${membershipId} AND response_status = 'accepted') AS ok
    `.execute(trx)).rows[0];
    if (!accepted?.ok) throw new ShiftClosureError("NO_ACCEPTED_ASSIGNMENT", 409);
    const already = (await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM verification_events WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
        AND organization_worker_membership_id = ${membershipId} AND event_type = 'check_in') AS ok
    `.execute(trx)).rows[0];
    if (already?.ok) throw new ShiftClosureError("ALREADY_CHECKED_IN", 409);

    const method = (await sql<{ id: string }>`SELECT id FROM verification_methods WHERE code = 'SUPERVISOR_OVERRIDE'`.execute(trx)).rows[0];
    if (!method) throw new ShiftClosureError("VERIFICATION_METHOD_MISSING", 500);
    const insertEvent = async (eventType: "check_in" | "check_out") => {
      const ev = (await sql<{ id: string; occurred_at: string }>`
        INSERT INTO verification_events (organization_id, shift_id, organization_worker_membership_id, verification_method_id,
          event_type, actor_user_id, actor_context, occurred_at)
        VALUES (${organizationId}, ${shiftId}, ${membershipId}, ${method.id}, ${eventType}, ${userId},
          'omitted_visit_correction', clock_timestamp())
        RETURNING id, occurred_at
      `.execute(trx)).rows[0];
      await sql`
        INSERT INTO verification_overrides (verification_event_id, organization_id, authorized_by_user_id, reason)
        VALUES (${ev.id}, ${organizationId}, ${userId}, ${input.reason})
      `.execute(trx);
      return ev;
    };
    const checkIn = await insertEvent("check_in");
    const checkOut = await insertEvent("check_out");
    await recordTimesheetFromCheckout(trx, {
      actorUserId: userId, organizationId, shiftId, membershipId,
      checkInAt: new Date(checkIn.occurred_at).toISOString(), checkOutAt: new Date(checkOut.occurred_at).toISOString(),
    });
    // The agency attests the service happened: the shift is completed (the database requires the
    // check-in that now exists). Hours stay «pending» until an admin enters the real minutes.
    await sql`UPDATE shifts SET status = 'completed', updated_at = now()
      WHERE id = ${shiftId} AND organization_id = ${organizationId} AND status IN ('unassigned', 'confirmed')`.execute(trx);
    const sheet = (await sql<{ id: string; status: string }>`
      SELECT id, status FROM timesheets WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
        AND organization_worker_membership_id = ${membershipId}
    `.execute(trx)).rows[0];
    return {
      shiftId,
      checkInEventId: checkIn.id,
      checkOutEventId: checkOut.id,
      recordedAt: iso(checkIn.occurred_at),
      timesheet: sheet ? { id: sheet.id, status: sheet.status } : null,
    };
  });
}

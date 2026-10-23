import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { MembershipNotActiveError } from "../../context/errors.js";
import { classifyProximity, distanceMeters } from "./verification.proximity.js";
export { ARRIVAL_RADIUS_M, classifyProximity, distanceMeters } from "./verification.proximity.js";
import {
  AssignmentNotAcceptedError, NoAssignmentError, NotOrgManagerError, ShiftCancelledError, ShiftCompletedError,
  ShiftNotFoundError, resolveMembership, resolveOccurredAt, resolveWorkerForUser,
} from "./verification.service.js";

/**
 * Gate 6 (migration 101): "Llegué" with an optional, consented, single proximity
 * check. The phone may send ONE reading; the server compares it with the shift's
 * confirmed address and keeps only the result and a rounded distance. The
 * coordinates are never stored or logged. No reading, no consent or "far" still
 * records the arrival and flags it for administrative review: never blocked.
 */

export const LOCATION_CONSENT_VERSION = "location-check-v1";
export class AlreadyArrivedError extends Error { constructor() { super("ALREADY_ARRIVED"); } }
export class ArrivalAfterCheckInError extends Error { constructor() { super("ALREADY_CHECKED_IN"); } }
export class LocationConsentRequiredError extends Error { constructor() { super("LOCATION_CONSENT_REQUIRED"); } }
export class NoArrivalToReviewError extends Error { constructor() { super("NO_ARRIVAL_TO_REVIEW"); } }

export const consentSchema = z.object({ consentVersion: z.literal(LOCATION_CONSENT_VERSION) }).strict();
export const arrivalSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  clientEventId: z.string().uuid().optional(),
  occurredAt: z.string().datetime().optional(),
  recordedOffline: z.boolean().optional(),
}).strict().refine((d) => (d.latitude === undefined) === (d.longitude === undefined), { message: "COORDINATES_PAIR" });
export const arrivalReviewSchema = z.object({
  membershipId: z.string().uuid(),
  note: z.string().trim().min(1).max(300),
}).strict();

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

async function ownMembership(trx: Trx, userId: string, organizationId: string) {
  const workerId = await resolveWorkerForUser(trx, userId);
  const membership = await resolveMembership(trx, workerId, organizationId);
  if (!membership) throw new NoAssignmentError();
  if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");
  return membership;
}

async function activeConsent(trx: Trx, membershipId: string) {
  const r = await sql<{ id: string; consent_version: string; granted_at: string }>`
    SELECT id, consent_version, granted_at FROM worker_location_consents
    WHERE organization_worker_membership_id = ${membershipId} AND revoked_at IS NULL LIMIT 1`.execute(trx);
  return r.rows[0] ?? null;
}

export async function getMyLocationConsent(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membership = await ownMembership(trx, userId, organizationId);
    const consent = await activeConsent(trx, membership.id);
    return { granted: Boolean(consent), consentVersion: consent?.consent_version ?? null, grantedAt: consent?.granted_at ?? null,
      currentVersion: LOCATION_CONSENT_VERSION };
  });
}

export async function grantLocationConsent(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membership = await ownMembership(trx, userId, organizationId);
    if (!(await activeConsent(trx, membership.id))) {
      await sql`
        INSERT INTO worker_location_consents (organization_id, organization_worker_membership_id, user_id, consent_version)
        VALUES (${organizationId}, ${membership.id}, ${userId}, ${LOCATION_CONSENT_VERSION})
        ON CONFLICT DO NOTHING`.execute(trx);
    }
    return { granted: true, consentVersion: LOCATION_CONSENT_VERSION };
  });
}

export async function revokeLocationConsent(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membership = await ownMembership(trx, userId, organizationId);
    await sql`UPDATE worker_location_consents SET revoked_at = now()
      WHERE organization_worker_membership_id = ${membership.id} AND revoked_at IS NULL`.execute(trx);
    return { granted: false };
  });
}

export async function recordArrival(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof arrivalSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membership = await ownMembership(trx, userId, organizationId);
    if (input.clientEventId) {
      const replay = await sql<{ occurred_at: string; proximity: string; distance_m: number | null; needs_review: boolean }>`
        SELECT occurred_at, proximity, distance_m, needs_review FROM shift_arrivals
        WHERE organization_id = ${organizationId} AND organization_worker_membership_id = ${membership.id}
          AND client_event_id = ${input.clientEventId}`.execute(trx);
      if (replay.rows[0]) return { ...toArrival(replay.rows[0]), replayed: true };
    }
    const shift = (await sql<{ id: string; status: string; care_recipient_id: string | null; service_location_id: string | null }>`
      SELECT id, status, care_recipient_id, service_location_id FROM shifts
      WHERE id = ${shiftId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!shift) throw new ShiftNotFoundError();
    if (shift.status === "cancelled") throw new ShiftCancelledError();
    if (shift.status === "completed") throw new ShiftCompletedError();
    const assignment = (await sql<{ response_status: string }>`
      SELECT response_status FROM assignments
      WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membership.id} AND organization_id = ${organizationId}
        AND response_status IN ('pending', 'accepted') LIMIT 1`.execute(trx)).rows[0];
    if (!assignment) throw new NoAssignmentError();
    if (assignment.response_status !== "accepted") throw new AssignmentNotAcceptedError();
    const existing = await sql`SELECT 1 FROM shift_arrivals WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membership.id}`.execute(trx);
    if (existing.rows[0]) throw new AlreadyArrivedError();
    const checkedIn = await sql`SELECT 1 FROM verification_events WHERE shift_id = ${shiftId}
      AND organization_worker_membership_id = ${membership.id} AND event_type = 'check_in'`.execute(trx);
    if (checkedIn.rows[0]) throw new ArrivalAfterCheckInError();

    const when = resolveOccurredAt(input.occurredAt, undefined, input.recordedOffline === true);
    const consent = await activeConsent(trx, membership.id);
    const hasReading = input.latitude !== undefined && input.longitude !== undefined;
    // A reading without consent is refused, never processed.
    if (hasReading && !consent) throw new LocationConsentRequiredError();

    let proximity: "NEAR" | "FAR" | "NO_CONSENT" | "UNAVAILABLE" | "NO_REFERENCE";
    let distanceM: number | null = null;
    if (!consent) proximity = "NO_CONSENT";
    else if (!hasReading) proximity = "UNAVAILABLE";
    else {
      // The shift's confirmed address (or the primary one); the worker reads it through RLS.
      const ref = shift.care_recipient_id ? (await sql<{ latitude: string | null; longitude: string | null }>`
        SELECT latitude, longitude FROM care_recipient_locations
        WHERE organization_id = ${organizationId} AND care_recipient_id = ${shift.care_recipient_id}
          AND gps_confirmed_at IS NOT NULL -- compare only with a point the agency confirmed
          AND ${shift.service_location_id ? sql`id = ${shift.service_location_id}` : sql`is_primary AND archived_at IS NULL`}`.execute(trx)).rows[0] : undefined;
      if (!ref || ref.latitude == null || ref.longitude == null) proximity = "NO_REFERENCE";
      else {
        const result = classifyProximity(
          distanceMeters({ lat: input.latitude!, lng: input.longitude! }, { lat: Number(ref.latitude), lng: Number(ref.longitude) }),
          input.accuracyM);
        proximity = result.proximity;
        distanceM = result.distanceM;
      }
    }
    const needsReview = proximity === "FAR" || proximity === "NO_CONSENT" || proximity === "UNAVAILABLE";
    const row = (await sql<{ occurred_at: string; proximity: string; distance_m: number | null; needs_review: boolean }>`
      INSERT INTO shift_arrivals (organization_id, shift_id, organization_worker_membership_id, recorded_by_user_id, occurred_at,
        recorded_offline, client_event_id, proximity, distance_m, accuracy_m, needs_review)
      VALUES (${organizationId}, ${shiftId}, ${membership.id}, ${userId}, COALESCE(${when.at}::timestamptz, now()), ${when.offline},
        ${input.clientEventId ?? null}, ${proximity}, ${distanceM},
        ${hasReading && input.accuracyM !== undefined ? Math.round(input.accuracyM) : null}, ${needsReview})
      RETURNING occurred_at, proximity, distance_m, needs_review`.execute(trx)).rows[0];
    return toArrival(row);
  });
}

function toArrival(r: { occurred_at: string; proximity: string; distance_m: number | null; needs_review: boolean }) {
  return { occurredAt: r.occurred_at, proximity: r.proximity, distanceM: r.distance_m, needsReview: r.needs_review };
}

/** Managers close the administrative review of an arrival (one time, with a note). */
export async function reviewArrival(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof arrivalReviewSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = (await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx)).rows[0]?.ok;
    if (!manager) throw new NotOrgManagerError();
    const r = await sql<{ reviewed_at: string }>`
      UPDATE shift_arrivals SET reviewed_by_user_id = ${userId}, reviewed_at = now(), review_note = ${input.note}
      WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
        AND organization_worker_membership_id = ${input.membershipId} AND needs_review AND reviewed_at IS NULL
      RETURNING reviewed_at`.execute(trx);
    if (!r.rows[0]) throw new NoArrivalToReviewError();
    return { reviewedAt: r.rows[0].reviewed_at };
  });
}

// ------------------------------------------------------------------ background
const LATE_CHECK_INTERVAL_MS = 60_000;

export async function notifyLateShiftArrivals(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_notify_late_shift_arrivals() AS n`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/** Same pattern as the coverage escalation worker: counts only, no tenant data in logs. */
export function startLateArrivalWorker(): () => void {
  const tick = async () => {
    try { await notifyLateShiftArrivals(); }
    catch (error) {
      const failure = error as { name?: string; code?: string };
      console.error("Late arrival worker failed", { name: failure.name ?? "Error", code: failure.code ?? "UNKNOWN" });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), LATE_CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

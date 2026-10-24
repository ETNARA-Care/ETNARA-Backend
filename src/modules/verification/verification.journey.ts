import { Router, type Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { OrganizationAccessDeniedError, InvalidOrganizationIdError } from "../organizationContext/organizationContext.service.js";
import {
  NoAssignmentError, NotOrgManagerError, OccurredAtOutOfRangeError, ShiftNotFoundError, WorkerNotLinkedError,
  resolveMembership, resolveOccurredAt, resolveWorkerForUser,
} from "./verification.service.js";

/**
 * Gate 7 «ETNARA En Camino» (migration 106). The caregiver declares «Voy en
 * camino» and, if needed, a delay (fixed minutes + reason category). No GPS,
 * no tracking, no estimated times. The journey state is derived in the
 * database (app_shift_journey_state) from the assignment, these declarations,
 * the arrival (101) and check-in/out, so «En camino» stops by itself.
 */

export const DELAY_MINUTES = [10, 15, 30, 45, 60] as const;
export const DELAY_REASONS = ["TRAFFIC", "PREVIOUS_SERVICE", "TRANSPORT", "WEATHER", "OTHER"] as const;

export const enRouteSchema = z.object({
  clientEventId: z.string().uuid().optional(),
  occurredAt: z.string().datetime().optional(),
  recordedOffline: z.boolean().optional(),
}).strict();
export const delaySchema = z.object({
  minutes: z.union([z.literal(10), z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  reason: z.enum(DELAY_REASONS),
  clientEventId: z.string().uuid().optional(),
}).strict();

export class JourneyRuleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "JourneyRuleError"; }
}

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];
export interface JourneyState {
  state: "UNASSIGNED" | "PENDING_ACCEPTANCE" | "ASSIGNED" | "EN_ROUTE" | "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED";
  enRouteAt: string | null;
  delay: { minutes: number; reason: (typeof DELAY_REASONS)[number]; reportedAt: string } | null;
  arrivedAt: string | null;
  /** Managers and the caregiver only; families never get it (decision 6). */
  arrivalNeedsReview?: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}
interface StateRow {
  state: JourneyState["state"]; en_route_at: Date | null; delay_minutes: number | null; delay_reason: string | null;
  delay_reported_at: Date | null; arrived_at: Date | null; arrival_needs_review: boolean | null;
  started_at: Date | null; finished_at: Date | null;
}
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export function toJourney(r: StateRow, includeReview: boolean): JourneyState {
  return {
    state: r.state,
    enRouteAt: iso(r.en_route_at),
    delay: r.delay_minutes && r.delay_reason && r.delay_reported_at
      ? { minutes: r.delay_minutes, reason: r.delay_reason as (typeof DELAY_REASONS)[number], reportedAt: iso(r.delay_reported_at)! }
      : null,
    arrivedAt: iso(r.arrived_at),
    ...(includeReview ? { arrivalNeedsReview: Boolean(r.arrival_needs_review) } : {}),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

/** Same, for many shifts in one round trip (app_shift_journey_states, migration 107). */
export async function journeyStates(trx: Trx, shiftIds: string[]): Promise<Map<string, StateRow>> {
  if (!shiftIds.length) return new Map();
  const r = await sql<StateRow & { shift_id: string }>`SELECT * FROM app_shift_journey_states(${shiftIds}::uuid[])`.execute(trx);
  return new Map(r.rows.map((x) => [x.shift_id, x]));
}

/** Derived state for one shift, or null when the caller may not see it. */
export async function journeyState(trx: Trx, shiftId: string): Promise<StateRow | null> {
  const r = await sql<StateRow>`SELECT * FROM app_shift_journey_state(${shiftId}::uuid)`.execute(trx);
  return r.rows[0] ?? null;
}

async function isManager(trx: Trx) {
  return Boolean((await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx)).rows[0]?.ok);
}

async function ownMembership(trx: Trx, userId: string, organizationId: string) {
  const workerId = await resolveWorkerForUser(trx, userId);
  const membership = await resolveMembership(trx, workerId, organizationId);
  if (!membership) throw new NoAssignmentError();
  if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");
  return membership;
}

function journeyDbError(error: unknown): never {
  const e = error as { code?: string; message?: string };
  const m = /JOURNEY_[A-Z_]+/.exec(e.message ?? "");
  if (m && m[0] === "JOURNEY_SHIFT_NOT_FOUND") throw new NoAssignmentError();
  if (m) throw new JourneyRuleError(m[0]);
  if (e.code === "42501") throw new NoAssignmentError(); // RLS: not this caregiver's shift
  throw error;
}

async function insertJourneyEvent(userId: string, organizationId: string, shiftId: string,
  ev: { type: "EN_ROUTE" | "DELAY_REPORTED"; minutes?: number; reason?: string; clientEventId?: string; occurredAt?: string; offline?: boolean }) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const membership = await ownMembership(trx, userId, organizationId);
    // Same 404 as the rest of the shift API when this is not the caller's shift
    // (no signal about whether it exists or belongs to another caregiver/agency).
    const mine = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId}
        AND a.organization_worker_membership_id = ${membership.id} AND a.response_status IN ('pending', 'accepted', 'rejected')) AS ok`.execute(trx);
    if (!mine.rows[0]?.ok) throw new NoAssignmentError();
    // Replays of the same device event return the stored one (idempotent).
    if (ev.clientEventId) {
      const prior = await sql<{ id: string }>`
        SELECT id FROM shift_journey_events WHERE organization_id = ${organizationId}
          AND organization_worker_membership_id = ${membership.id} AND client_event_id = ${ev.clientEventId}`.execute(trx);
      if (prior.rows[0]) return { replayed: true as const, journey: toJourney((await journeyState(trx, shiftId))!, true) };
    }
    if (ev.type === "EN_ROUTE") {
      const already = await sql<{ id: string }>`
        SELECT id FROM shift_journey_events WHERE shift_id = ${shiftId} AND organization_id = ${organizationId}
          AND organization_worker_membership_id = ${membership.id} AND event_type = 'EN_ROUTE'`.execute(trx);
      if (already.rows[0]) {
        const st = await journeyState(trx, shiftId);
        if (st) return { replayed: true as const, journey: toJourney(st, true) };
      }
    }
    const when = resolveOccurredAt(ev.occurredAt, undefined, ev.offline === true);
    try {
      await sql`SAVEPOINT journey_insert`.execute(trx);
      await sql`
        INSERT INTO shift_journey_events (organization_id, shift_id, organization_worker_membership_id, recorded_by_user_id,
          event_type, occurred_at, declared_delay_minutes, delay_reason, recorded_offline, client_event_id)
        VALUES (${organizationId}, ${shiftId}, ${membership.id}, ${userId}, ${ev.type},
          COALESCE(${when.at}::timestamptz, now()), ${ev.minutes ?? null}, ${ev.reason ?? null}, ${when.offline}, ${ev.clientEventId ?? null})`.execute(trx);
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT journey_insert`.execute(trx);
      const e = error as { code?: string };
      // Concurrent double tap: the unique departure index decides, the loser replays.
      if (e.code === "23505" && ev.type === "EN_ROUTE") {
        const st = await journeyState(trx, shiftId);
        if (st) return { replayed: true as const, journey: toJourney(st, true) };
      }
      journeyDbError(error);
    }
    const st = await journeyState(trx, shiftId);
    if (!st) throw new NoAssignmentError();
    return { journey: toJourney(st, true) };
  });
}

export const declareEnRoute = (userId: string, organizationId: string, shiftId: string, input: z.infer<typeof enRouteSchema>) =>
  insertJourneyEvent(userId, organizationId, shiftId, { type: "EN_ROUTE", clientEventId: input.clientEventId, occurredAt: input.occurredAt, offline: input.recordedOffline });

export const reportDelay = (userId: string, organizationId: string, shiftId: string, input: z.infer<typeof delaySchema>) =>
  insertJourneyEvent(userId, organizationId, shiftId, { type: "DELAY_REPORTED", minutes: input.minutes, reason: input.reason, clientEventId: input.clientEventId });

/** State for the agency or the assigned caregiver; the agency also gets the operational history. */
export async function getShiftJourney(userId: string, organizationId: string, shiftId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const st = await journeyState(trx, shiftId);
    if (!st) throw new ShiftNotFoundError();
    const manager = await isManager(trx);
    if (!manager) {
      // Families read the state through their own route (family-shifts), never here.
      const mine = await sql<{ ok: boolean }>`SELECT app_worker_has_shift_assignment(${shiftId}::uuid) AS ok`.execute(trx);
      const own = await sql<{ id: string }>`
        SELECT a.id FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
        JOIN workers w ON w.id = owm.worker_id
        WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId} AND w.user_id = ${userId}`.execute(trx);
      if (!mine.rows[0]?.ok && !own.rows[0]) throw new ShiftNotFoundError();
      return { journey: toJourney(st, true) };
    }
    return { journey: toJourney(st, true), history: await operationalHistory(trx, organizationId, shiftId) };
  });
}

export interface HistoryItem { at: string; kind: string; detail?: Record<string, unknown> }

/** «Historial operativo»: everything that happened to the visit, in order (managers only). */
async function operationalHistory(trx: Trx, organizationId: string, shiftId: string): Promise<HistoryItem[]> {
  const r = await sql<{ at: Date; kind: string; detail: Record<string, unknown> | null }>`
    SELECT a.created_at AS at, 'ASSIGNED' AS kind, jsonb_build_object('caregiver', w.display_name) AS detail
      FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId}
    UNION ALL
    SELECT a.responded_at, CASE a.response_status::text WHEN 'accepted' THEN 'ACCEPTED' ELSE 'DECLINED' END,
           jsonb_build_object('caregiver', w.display_name)
      FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
      WHERE a.shift_id = ${shiftId} AND a.organization_id = ${organizationId} AND a.responded_at IS NOT NULL
        AND a.response_status::text IN ('accepted', 'rejected')
    UNION ALL
    -- Migration 113: removals / reassignments are part of the visit's history (who was taken off).
    SELECT ra.removed_at, 'UNASSIGNED', jsonb_build_object('caregiver', w.display_name)
      FROM assignment_removal_audit ra JOIN organization_worker_memberships owm ON owm.id = ra.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id WHERE ra.shift_id = ${shiftId} AND ra.organization_id = ${organizationId}
    UNION ALL
    SELECT e.occurred_at, e.event_type,
           -- Migration 113: a record made without signal keeps the phone's time and is marked so the agency can tell
           NULLIF(jsonb_strip_nulls(jsonb_build_object('minutes', e.declared_delay_minutes, 'reason', e.delay_reason,
             'offline', CASE WHEN e.recorded_offline THEN true END)), '{}'::jsonb)
      FROM shift_journey_events e WHERE e.shift_id = ${shiftId} AND e.organization_id = ${organizationId}
    UNION ALL
    SELECT sa.occurred_at, 'ARRIVED', jsonb_strip_nulls(jsonb_build_object('proximity', sa.proximity, 'needsReview', sa.needs_review,
             'reviewed', sa.reviewed_at IS NOT NULL, 'offline', CASE WHEN sa.recorded_offline THEN true END))
      FROM shift_arrivals sa WHERE sa.shift_id = ${shiftId} AND sa.organization_id = ${organizationId}
    UNION ALL
    SELECT ve.occurred_at, CASE ve.event_type::text WHEN 'check_in' THEN 'STARTED' ELSE 'FINISHED' END, NULL
      FROM verification_events ve WHERE ve.shift_id = ${shiftId} AND ve.organization_id = ${organizationId}
    UNION ALL
    SELECT s.updated_at, 'CANCELLED', NULL FROM shifts s
      WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId} AND s.status = 'cancelled'
    ORDER BY 1`.execute(trx);
  return r.rows.map((x) => ({ at: iso(x.at)!, kind: x.kind, ...(x.detail ? { detail: x.detail } : {}) }));
}

export type JourneyRisk = "NOT_EN_ROUTE" | "LATE_ARRIVAL" | "DELAY_30";

/** «Hoy en ruta»: today's visits (Puerto Rico day) with state and risks. Managers only. */
export async function listTodayJourneys(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    if (!(await isManager(trx))) throw new NotOrgManagerError();
    const shifts = await sql<{ id: string; scheduled_start: Date; scheduled_end: Date; recipient: string | null; caregiver: string | null }>`
      SELECT s.id, s.scheduled_start, s.scheduled_end,
             NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '') AS recipient,
             (SELECT w.display_name FROM assignments a JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
                JOIN workers w ON w.id = owm.worker_id
              WHERE a.shift_id = s.id AND a.organization_id = s.organization_id AND a.response_status IN ('pending', 'accepted')
              ORDER BY (a.response_status = 'accepted') DESC, a.created_at DESC LIMIT 1) AS caregiver
      FROM shifts s LEFT JOIN care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
      WHERE s.organization_id = ${organizationId}
        -- Puerto Rico «today» as a range (index-friendly); overnight visits still in progress included (audit M6/L11).
        AND s.scheduled_start < (date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') + interval '1 day') AT TIME ZONE 'America/Puerto_Rico'
        AND s.scheduled_end > date_trunc('day', now() AT TIME ZONE 'America/Puerto_Rico') AT TIME ZONE 'America/Puerto_Rico'
      ORDER BY s.scheduled_start
      LIMIT 500`.execute(trx);
    const states = await journeyStates(trx, shifts.rows.map((r) => r.id));
    const now = Date.now();
    const items = [];
    for (const s of shifts.rows) {
      const st = states.get(s.id);
      if (!st) continue;
      const j = toJourney(st, true);
      const start = new Date(s.scheduled_start).getTime();
      const risks: JourneyRisk[] = [];
      const waiting = ["PENDING_ACCEPTANCE", "ASSIGNED"].includes(j.state);
      if (waiting && now >= start - 30 * 60_000 && now < start) risks.push("NOT_EN_ROUTE");
      // Same rule as the agency alert (migration 113): 15 min after start + the declared delay.
      const declared = ["ASSIGNED", "EN_ROUTE"].includes(j.state) ? (j.delay?.minutes ?? 0) : 0;
      if (["PENDING_ACCEPTANCE", "ASSIGNED", "EN_ROUTE"].includes(j.state) && now >= start + (15 + declared) * 60_000) risks.push("LATE_ARRIVAL");
      if (j.delay && j.delay.minutes >= 30 && ["ASSIGNED", "EN_ROUTE"].includes(j.state)) risks.push("DELAY_30");
      items.push({ shiftId: s.id, scheduledStart: iso(s.scheduled_start), scheduledEnd: iso(s.scheduled_end),
        recipient: s.recipient, caregiver: s.caregiver, journey: j, risks });
    }
    return { journeys: items };
  });
}

// ------------------------------------------------------------------ background
export async function notifyShiftsNotEnRoute(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_notify_shifts_not_en_route() AS n`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------ routes
const uuid = z.string().uuid();
const router = Router();
function fail(err: unknown, res: Response) {
  if (err instanceof JourneyRuleError) { res.status(409).json({ error: err.code }); return; }
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) { res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" }); return; }
  if (err instanceof NotOrgManagerError) { res.status(403).json({ error: "NOT_ORG_MANAGER" }); return; }
  if (err instanceof WorkerNotLinkedError) { res.status(403).json({ error: "USER_HAS_NO_WORKER_PROFILE" }); return; }
  if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) { res.status(400).json({ error: "INVALID_ID" }); return; }
  if (err instanceof ShiftNotFoundError || err instanceof NoAssignmentError) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  if (err instanceof OccurredAtOutOfRangeError) { res.status(400).json({ error: "OCCURRED_AT_OUT_OF_RANGE" }); return; }
  console.error("JOURNEY_ERROR", { code: (err as { code?: string })?.code ?? "UNKNOWN" });
  res.status(500).json({ error: "INTERNAL_ERROR" });
}
type H = (req: AuthenticatedRequest, res: Response, orgId: string, shiftId?: string) => Promise<void>;
const wrap = (h: H, withShift = true) => async (req: AuthenticatedRequest, res: Response) => {
  const o = uuid.safeParse(req.params.organizationId);
  const s = withShift ? uuid.safeParse(req.params.shiftId) : { success: true as const, data: undefined };
  if (!o.success || !s.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
  try { await h(req, res, o.data, s.data); } catch (e) { fail(e, res); }
};
const S = "/organizations/:organizationId/shifts/:shiftId/journey";
router.get(S, requireAuth, wrap(async (req, res, o, s) => { res.json(await getShiftJourney(req.auth!.userId, o, s!)); }));
router.post(`${S}/en-route`, requireAuth, wrap(async (req, res, o, s) => {
  const b = enRouteSchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  const r = await declareEnRoute(req.auth!.userId, o, s!, b.data);
  res.status("replayed" in r ? 200 : 201).json({ journey: r.journey });
}));
router.post(`${S}/delay`, requireAuth, wrap(async (req, res, o, s) => {
  const b = delaySchema.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  const r = await reportDelay(req.auth!.userId, o, s!, b.data);
  res.status("replayed" in r ? 200 : 201).json({ journey: r.journey });
}));
router.get("/organizations/:organizationId/operations/journeys", requireAuth,
  wrap(async (req, res, o) => { res.json(await listTodayJourneys(req.auth!.userId, o)); }, false));

export default router;

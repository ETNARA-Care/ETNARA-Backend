import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { lockWorkerSchedule } from "../assignments/assignments.service.js";
import { evaluateWorkerEligibilityInTransaction } from "../eligibility/eligibility.service.js";
import { ResidentialError, RESIDENTIAL_MANAGER_REQUIRED, RESIDENTIAL_NOT_FOUND } from "./residentialErrors.js";
import type { assignResidentsSchema, redistributeSchema, substitutionPreviewSchema, substitutionSchema } from "./residentAssignments.schemas.js";

/**
 * 176 · Hogares F3: asignación de residentes por turno (por periodo) y sustitución administrativa (D7).
 *
 *   - Solo hogares (residentialGate). La asignación exige HOGAR_ASIGNACIONES (orgFeatureGate); la sustitución exige
 *     HOGAR_CALENDARIO y HOGAR_ASIGNACIONES: si falta cualquiera, 403 (plan §6 F3).
 *   - El acceso a un residente sale solo de una asignación abierta AHORA (rama nueva de la RLS). Redistribuir y sustituir
 *     cierran y abren a la misma hora efectiva: nunca coinciden dos accesos.
 *   - Bloqueos que no se pueden anular en la sustitución: elegibilidad y credenciales, puesto, autorización en el
 *     establecimiento, solape real (turnos nocturnos, cambios de fecha y sustituciones parciales). La disponibilidad
 *     declarada es solo una advertencia que se confirma. Motivo por categoría, sin datos de salud.
 *   - Las asignaciones de residentes no llevan tiempo: en hogares las horas salen solo de los ponches, que no se tocan.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trx = Transaction<any>;

export class AssignmentError extends ResidentialError {
  constructor(code: string, status: number, public readonly details?: Record<string, unknown>) { super(code, status); }
}
const notFound = () => new ResidentialError(RESIDENTIAL_NOT_FOUND, 404);
const SKEW_MS = 2 * 60_000;

async function requireManager(trx: Trx) {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new ResidentialError(RESIDENTIAL_MANAGER_REQUIRED, 403);
}
const manage = <T>(userId: string, organizationId: string, fn: (trx: Trx) => Promise<T>) =>
  withTenantContext({ userId, organizationId }, async (trx) => { await requireManager(trx); return fn(trx); });

type ShiftRow = { id: string; location_id: string; location_name: string; scheduled_start: string; scheduled_end: string; status: string; required_role: string };
async function establishmentShift(trx: Trx, organizationId: string, shiftId: string): Promise<ShiftRow> {
  const r = await sql<ShiftRow>`
    SELECT s.id, t.location_id, l.name AS location_name, s.scheduled_start, s.scheduled_end, s.status::text AS status, s.required_role
    FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id
    JOIN locations l ON l.id = t.location_id AND l.organization_id = s.organization_id
    WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId}`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
const instant = (iso: string | undefined, fallback: Date) => (iso ? new Date(iso) : fallback);
function assertNotPast(at: Date, now: Date) {
  if (at.getTime() < now.getTime() - SKEW_MS) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_RETROACTIVE", 409);
}

type StaffRow = { membership_id: string; name: string | null; internal_role: string | null; cov_start: string; cov_end: string; assignment_status: string };
async function shiftStaff(trx: Trx, shiftId: string): Promise<StaffRow[]> {
  const r = await sql<StaffRow>`
    SELECT a.organization_worker_membership_id AS membership_id, w.display_name AS name, m.internal_role, c.cov_start, c.cov_end, a.response_status AS assignment_status
    FROM assignments a JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id JOIN workers w ON w.id = m.worker_id
    CROSS JOIN LATERAL app_residential_coverage_bounds(a.shift_id, a.organization_worker_membership_id) c
    WHERE a.shift_id = ${shiftId} AND a.response_status IN ('pending', 'accepted')
    ORDER BY w.display_name, a.organization_worker_membership_id`.execute(trx);
  return r.rows;
}
type SraRow = { id: string; membership_id: string; care_recipient_id: string; effective_from: string; effective_until: string | null; origin: string; close_reason: string | null };
async function shiftAssignments(trx: Trx, shiftId: string): Promise<SraRow[]> {
  const r = await sql<SraRow>`
    SELECT id, organization_worker_membership_id AS membership_id, care_recipient_id, effective_from, effective_until, origin, close_reason
    FROM shift_resident_assignments WHERE shift_id = ${shiftId} ORDER BY effective_from, id`.execute(trx);
  return r.rows;
}
type ResidentRow = { id: string; name: string; room_name: string | null };
async function establishmentResidents(trx: Trx, organizationId: string, locationId: string): Promise<ResidentRow[]> {
  const r = await sql<ResidentRow>`
    SELECT cr.id, COALESCE(NULLIF(cr.preferred_name, ''), cr.first_name || ' ' || cr.last_name) AS name,
           (SELECT ro.name FROM rooms ro WHERE ro.id = cr.room_id AND NOT app_is_technical_room(ro.id)) AS room_name
    FROM care_recipients cr WHERE cr.organization_id = ${organizationId} AND cr.location_id = ${locationId} AND cr.status = 'active'
    ORDER BY 2, cr.id`.execute(trx);
  return r.rows;
}

/** Periodo de una asignación recortado a la cobertura de su persona. Abierta en `at`: desde ≤ at < hasta. */
function periodEnd(a: SraRow, staff: StaffRow[]): number {
  const cov = staff.find((s) => s.membership_id === a.membership_id);
  const covEnd = cov ? new Date(cov.cov_end).getTime() : new Date(a.effective_from).getTime();
  return Math.min(a.effective_until ? new Date(a.effective_until).getTime() : covEnd, covEnd);
}
function openAt(a: SraRow, staff: StaffRow[], at: number) { return new Date(a.effective_from).getTime() <= at && at < periodEnd(a, staff); }
/** Abierta o por empezar (cubre algo desde `at`). */
function coversFrom(a: SraRow, staff: StaffRow[], at: number) { return periodEnd(a, staff) > at && periodEnd(a, staff) > new Date(a.effective_from).getTime(); }

/** Tablero de un turno: personal y su cobertura, residentes del establecimiento, periodos, totales, compartidos y sin cobertura. */
async function board(trx: Trx, organizationId: string, shift: ShiftRow, now: Date) {
  const [staff, sras, residents] = await Promise.all([shiftStaff(trx, shift.id), shiftAssignments(trx, shift.id), establishmentResidents(trx, organizationId, shift.location_id)]);
  const at = Math.max(now.getTime(), new Date(shift.scheduled_start).getTime());
  const ended = now.getTime() >= new Date(shift.scheduled_end).getTime() || shift.status === "cancelled";
  const residentsOut = residents.map((r) => {
    const mine = sras.filter((a) => a.care_recipient_id === r.id);
    const current = mine.filter((a) => coversFrom(a, staff, at));
    return {
      id: r.id, name: r.name, roomName: r.room_name,
      assignments: mine.map((a) => ({ id: a.id, membershipId: a.membership_id, from: a.effective_from, until: new Date(periodEnd(a, staff)).toISOString(),
        closed: a.effective_until !== null, closeReason: a.close_reason, origin: a.origin, activeNow: openAt(a, staff, now.getTime()) })),
      coveredBy: [...new Set(current.map((a) => a.membership_id))],
      shared: new Set(current.map((a) => a.membership_id)).size > 1,
      uncovered: !ended && current.length === 0,
    };
  });
  return {
    shift: { id: shift.id, establishment: { id: shift.location_id, name: shift.location_name }, scheduledStart: shift.scheduled_start, scheduledEnd: shift.scheduled_end, status: shift.status, requiredRole: shift.required_role, ended },
    staff: staff.map((s) => ({ membershipId: s.membership_id, name: s.name, role: s.internal_role, coverageStart: s.cov_start, coverageEnd: s.cov_end,
      accepted: s.assignment_status === "accepted",
      residentCount: residentsOut.filter((r) => r.coveredBy.includes(s.membership_id)).length })),
    residents: residentsOut,
    totals: { residents: residentsOut.length, covered: residentsOut.filter((r) => !r.uncovered).length, uncovered: residentsOut.filter((r) => r.uncovered).length,
      shared: residentsOut.filter((r) => r.shared).length },
  };
}

export function assignmentEstablishments(userId: string, organizationId: string) {
  return manage(userId, organizationId, async (trx) => (await sql<{ id: string; name: string }>`
    SELECT l.id, l.name FROM locations l WHERE l.organization_id = ${organizationId} AND l.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.location_id = l.id) ORDER BY l.name, l.id`.execute(trx)).rows);
}

/** Turnos del establecimiento que tocan un día local (Puerto Rico), con su tablero. */
export function dayBoards(userId: string, organizationId: string, locationId: string, date: string, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    const loc = await sql`SELECT 1 FROM locations l JOIN establishment_technical_rooms t ON t.location_id = l.id WHERE l.id = ${locationId} AND l.organization_id = ${organizationId}`.execute(trx);
    if (!loc.rows[0]) throw notFound();
    const shifts = (await sql<ShiftRow>`
      SELECT s.id, t.location_id, l.name AS location_name, s.scheduled_start, s.scheduled_end, s.status::text AS status, s.required_role
      FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id AND t.location_id = ${locationId}
      JOIN locations l ON l.id = t.location_id
      WHERE s.organization_id = ${organizationId} AND s.status::text <> 'cancelled'
        AND s.scheduled_end > (${date}::date::timestamp AT TIME ZONE 'America/Puerto_Rico')
        AND s.scheduled_start < ((${date}::date + 1)::timestamp AT TIME ZONE 'America/Puerto_Rico')
      ORDER BY s.scheduled_start, s.id`.execute(trx)).rows;
    const out = [];
    for (const s of shifts) out.push(await board(trx, organizationId, s, now));
    return out;
  });
}
export function shiftBoard(userId: string, organizationId: string, shiftId: string, now = new Date()) {
  return manage(userId, organizationId, async (trx) => board(trx, organizationId, await establishmentShift(trx, organizationId, shiftId), now));
}

/** Asignar residentes a una persona del turno, desde ahora (o una hora futura dentro de su cobertura). */
export function assignResidents(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof assignResidentsSchema>, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    const shift = await establishmentShift(trx, organizationId, shiftId);
    if (shift.status === "cancelled") throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_SHIFT_CANCELLED", 409);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`residential-assign:${shiftId}`}))`.execute(trx);
    const staff = (await shiftStaff(trx, shiftId)).find((s) => s.membership_id === input.membershipId && s.assignment_status === "accepted");
    if (!staff) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_STAFF_NOT_ASSIGNED", 409);
    const from = new Date(Math.max(instant(input.effectiveAt, now).getTime(), new Date(staff.cov_start).getTime(), now.getTime()));
    if (input.effectiveAt) assertNotPast(new Date(input.effectiveAt), now);
    if (from.getTime() >= new Date(staff.cov_end).getTime()) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_OUTSIDE_COVERAGE", 409);
    const created: string[] = [];
    for (const r of [...new Set(input.careRecipientIds)]) {
      const row = await sql<{ id: string }>`
        INSERT INTO shift_resident_assignments (organization_id, location_id, shift_id, organization_worker_membership_id, care_recipient_id, effective_from, created_by_user_id)
        VALUES (${organizationId}, ${shift.location_id}, ${shiftId}, ${input.membershipId}, ${r}, ${from.toISOString()}, ${userId}) RETURNING id`.execute(trx);
      created.push(row.rows[0].id);
    }
    return { assigned: created.length, effectiveFrom: from.toISOString() };
  });
}

/**
 * Redistribuir: cada residente pasa de una persona a otra (o se deja de asignar) a la misma hora efectiva. Si alguien
 * queda sin cobertura, hace falta confirmarlo con motivo y se crea una alerta pendiente.
 */
export function redistribute(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof redistributeSchema>, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    const shift = await establishmentShift(trx, organizationId, shiftId);
    if (shift.status === "cancelled") throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_SHIFT_CANCELLED", 409);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`residential-assign:${shiftId}`}))`.execute(trx);
    if (input.effectiveAt) assertNotPast(new Date(input.effectiveAt), now);
    const at = new Date(Math.max(instant(input.effectiveAt, now).getTime(), new Date(shift.scheduled_start).getTime(), now.getTime()));
    if (at.getTime() >= new Date(shift.scheduled_end).getTime()) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_OUTSIDE_COVERAGE", 409);
    const staff = await shiftStaff(trx, shiftId);
    let sras = await shiftAssignments(trx, shiftId);
    // Comprobar todo antes de escribir.
    for (const m of input.moves) {
      if (!sras.some((a) => a.care_recipient_id === m.careRecipientId && a.membership_id === m.fromMembershipId && a.effective_until === null && coversFrom(a, staff, at.getTime()))) {
        throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_NOT_FOUND", 409, { careRecipientId: m.careRecipientId });
      }
      if (m.toMembershipId && !staff.some((s) => s.membership_id === m.toMembershipId && s.assignment_status === "accepted"
          && new Date(s.cov_start).getTime() <= at.getTime() && at.getTime() < new Date(s.cov_end).getTime())) {
        throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_STAFF_NOT_ASSIGNED", 409, { membershipId: m.toMembershipId });
      }
    }
    const uncovered = [...new Set(input.moves.map((m) => m.careRecipientId))].filter((r) => {
      const remaining = sras.filter((a) => a.care_recipient_id === r && coversFrom(a, staff, at.getTime())
        && !input.moves.some((m) => m.careRecipientId === r && m.fromMembershipId === a.membership_id));
      return remaining.length === 0 && !input.moves.some((m) => m.careRecipientId === r && m.toMembershipId);
    });
    if (uncovered.length > 0 && !(input.confirmUncovered && input.uncoveredReason)) {
      throw new AssignmentError("RESIDENTIAL_UNCOVERED_CONFIRMATION_REQUIRED", 409, { uncovered });
    }
    for (const m of input.moves) {
      const open = sras.find((a) => a.care_recipient_id === m.careRecipientId && a.membership_id === m.fromMembershipId && a.effective_until === null)!;
      const until = new Date(Math.max(at.getTime(), new Date(open.effective_from).getTime()));
      await sql`UPDATE shift_resident_assignments SET effective_until = ${until.toISOString()}, close_reason = ${m.toMembershipId ? "redistribution" : "ended"},
        closed_by_user_id = ${userId} WHERE id = ${open.id}`.execute(trx);
      // Si la persona de destino ya atiende a este residente (compartido), su periodo abierto continúa sin duplicarse.
      const already = m.toMembershipId && sras.some((a) => a.care_recipient_id === m.careRecipientId && a.membership_id === m.toMembershipId && a.effective_until === null);
      if (m.toMembershipId && !already) {
        await sql`INSERT INTO shift_resident_assignments (organization_id, location_id, shift_id, organization_worker_membership_id, care_recipient_id, effective_from, origin, created_by_user_id)
          VALUES (${organizationId}, ${shift.location_id}, ${shiftId}, ${m.toMembershipId}, ${m.careRecipientId}, ${at.toISOString()}, 'redistribution', ${userId})`.execute(trx);
      }
      sras = sras.map((a) => (a.id === open.id ? { ...a, effective_until: until.toISOString() } : a));
    }
    for (const r of uncovered) {
      await sql`INSERT INTO shift_coverage_alerts (organization_id, location_id, shift_id, care_recipient_id, uncovered_from, reason, created_by_user_id)
        VALUES (${organizationId}, ${shift.location_id}, ${shiftId}, ${r}, ${at.toISOString()}, ${input.uncoveredReason!}, ${userId})`.execute(trx);
    }
    return { moved: input.moves.length, effectiveAt: at.toISOString(), uncovered };
  });
}

/** Historial completo del turno: periodos de cada residente, sustituciones y alertas de cobertura. */
export function shiftHistory(userId: string, organizationId: string, shiftId: string) {
  return manage(userId, organizationId, async (trx) => {
    await establishmentShift(trx, organizationId, shiftId);
    const periods = await sql<{ id: string; resident: string; worker: string | null; effective_from: string; effective_until: string | null; origin: string;
      close_reason: string | null; created_at: string; created_by: string | null; closed_at: string | null; closed_by: string | null }>`
      SELECT x.id, COALESCE(NULLIF(cr.preferred_name, ''), cr.first_name || ' ' || cr.last_name) AS resident, w.display_name AS worker,
             x.effective_from, x.effective_until, x.origin, x.close_reason, x.created_at, cu.email AS created_by, x.closed_at, zu.email AS closed_by
      FROM shift_resident_assignments x JOIN care_recipients cr ON cr.id = x.care_recipient_id
      JOIN organization_worker_memberships m ON m.id = x.organization_worker_membership_id JOIN workers w ON w.id = m.worker_id
      LEFT JOIN users cu ON cu.id = x.created_by_user_id LEFT JOIN users zu ON zu.id = x.closed_by_user_id
      WHERE x.shift_id = ${shiftId} ORDER BY x.created_at, x.id`.execute(trx);
    const subs = await sql<{ id: string; original: string | null; substitute: string | null; effective_at: string; full_replacement: boolean; reason_code: string;
      reason_note: string | null; availability_warning: boolean; uncovered: string[]; created_at: string; created_by: string | null }>`
      SELECT x.id, wo.display_name AS original, ws.display_name AS substitute, x.effective_at, x.full_replacement, x.reason_code, x.reason_note,
             x.availability_warning, ARRAY(SELECT jsonb_array_elements_text(x.uncovered)) AS uncovered, x.created_at, u.email AS created_by
      FROM shift_substitutions x
      JOIN organization_worker_memberships mo ON mo.id = x.original_membership_id JOIN workers wo ON wo.id = mo.worker_id
      JOIN organization_worker_memberships ms ON ms.id = x.substitute_membership_id JOIN workers ws ON ws.id = ms.worker_id
      LEFT JOIN users u ON u.id = x.created_by_user_id
      WHERE x.shift_id = ${shiftId} ORDER BY x.created_at, x.id`.execute(trx);
    return {
      periods: periods.rows.map((p) => ({ id: p.id, resident: p.resident, worker: p.worker, from: p.effective_from, until: p.effective_until, origin: p.origin,
        closeReason: p.close_reason, createdAt: p.created_at, createdBy: p.created_by, closedAt: p.closed_at, closedBy: p.closed_by })),
      substitutions: subs.rows.map((x) => ({ id: x.id, original: x.original, substitute: x.substitute, effectiveAt: x.effective_at, fullReplacement: x.full_replacement,
        reasonCode: x.reason_code, reasonNote: x.reason_note, availabilityWarning: x.availability_warning, uncoveredCount: x.uncovered.length, createdAt: x.created_at, createdBy: x.created_by })),
    };
  });
}

export function coverageAlerts(userId: string, organizationId: string, open: boolean) {
  return manage(userId, organizationId, async (trx) => (await sql<{ id: string; shift_id: string; resident: string; location: string; uncovered_from: string; reason: string;
    created_at: string; resolved_at: string | null }>`
    SELECT a.id, a.shift_id, COALESCE(NULLIF(cr.preferred_name, ''), cr.first_name || ' ' || cr.last_name) AS resident, l.name AS location, a.uncovered_from, a.reason,
           a.created_at, a.resolved_at
    FROM shift_coverage_alerts a JOIN care_recipients cr ON cr.id = a.care_recipient_id JOIN locations l ON l.id = a.location_id
    WHERE a.organization_id = ${organizationId} ${open ? sql`AND a.resolved_at IS NULL` : sql``}
    ORDER BY a.created_at DESC LIMIT 200`.execute(trx)).rows.map((a) => ({ id: a.id, shiftId: a.shift_id, resident: a.resident, location: a.location,
    uncoveredFrom: a.uncovered_from, reason: a.reason, createdAt: a.created_at, resolvedAt: a.resolved_at })));
}
export function resolveCoverageAlert(userId: string, organizationId: string, alertId: string) {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string }>`UPDATE shift_coverage_alerts SET resolved_at = now(), resolved_by_user_id = ${userId}
      WHERE id = ${alertId} AND organization_id = ${organizationId} AND resolved_at IS NULL RETURNING id`.execute(trx);
    if (!r.rows[0]) throw notFound();
    return { id: alertId, resolved: true };
  });
}

/** «Mis residentes»: solo los asignados AHORA a quien pregunta (la RLS decide; sin asignación, cero residentes). */
export function myResidents(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await sql<{ shift_id: string; location_name: string; care_recipient_id: string; name: string; until: string }>`
      SELECT x.shift_id, l.name AS location_name, cr.id AS care_recipient_id,
             COALESCE(NULLIF(cr.preferred_name, ''), cr.first_name || ' ' || cr.last_name) AS name,
             LEAST(COALESCE(x.effective_until, c.cov_end), c.cov_end) AS until
      FROM shift_resident_assignments x
      JOIN care_recipients cr ON cr.id = x.care_recipient_id
      JOIN locations l ON l.id = x.location_id
      CROSS JOIN LATERAL app_residential_coverage_bounds(x.shift_id, x.organization_worker_membership_id) c
      WHERE x.organization_id = ${organizationId} AND app_is_own_worker_membership(x.organization_worker_membership_id)
        AND app_residential_worker_has_recipient(x.care_recipient_id)
        AND x.effective_from <= now() AND now() < LEAST(COALESCE(x.effective_until, c.cov_end), c.cov_end)
      ORDER BY 4, cr.id`.execute(trx);
    return r.rows.map((x) => ({ shiftId: x.shift_id, establishment: x.location_name, careRecipientId: x.care_recipient_id, name: x.name, until: x.until }));
  });
}

// ---- Sustitución administrativa (D7) ------------------------------------------------------------------------------
async function requireBothFeatures(trx: Trx, organizationId: string) {
  const r = await sql<{ cal: boolean; asg: boolean }>`SELECT app_org_feature_enabled(${organizationId}::uuid, 'HOGAR_CALENDARIO') AS cal,
    app_org_feature_enabled(${organizationId}::uuid, 'HOGAR_ASIGNACIONES') AS asg`.execute(trx);
  if (!r.rows[0]?.cal || !r.rows[0]?.asg) throw new AssignmentError("RESIDENTIAL_SUBSTITUTION_NOT_AVAILABLE", 403);
}

type Evaluation = {
  shift: ShiftRow; at: Date; blocks: string[]; availabilityWarning: boolean; originalResidents: string[];
  substituteRole: string | null; staff: StaffRow[]; sras: SraRow[];
};
/** Bloqueos que no se pueden anular y advertencias; no escribe nada. */
async function evaluateSubstitution(trx: Trx, organizationId: string, shiftId: string, input: z.infer<typeof substitutionPreviewSchema>, now: Date): Promise<Evaluation> {
  const shift = await establishmentShift(trx, organizationId, shiftId);
  if (input.effectiveAt) assertNotPast(new Date(input.effectiveAt), now);
  const at = new Date(Math.max(instant(input.effectiveAt, now).getTime(), now.getTime()));
  const effective = new Date(Math.max(at.getTime(), new Date(shift.scheduled_start).getTime()));
  const blocks: string[] = [];
  if (shift.status === "cancelled") blocks.push("shift_cancelled");
  if (effective.getTime() >= new Date(shift.scheduled_end).getTime()) blocks.push("shift_ended");
  const staff = await shiftStaff(trx, shiftId);
  const original = staff.find((s) => s.membership_id === input.originalMembershipId && s.assignment_status === "accepted");
  // 27-nov: una persona ya sustituida en este turno no se vuelve a sustituir (ni con una hora anterior): su cobertura ya
  // terminó y habría dos sustitutas cubriendo a la vez su lugar. Para cambiar a la sustituta, se sustituye a la sustituta.
  const alreadySubstituted = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM shift_substitutions
    WHERE shift_id = ${shiftId} AND original_membership_id = ${input.originalMembershipId}`.execute(trx)).rows[0]?.n ?? 0;
  if (!original || alreadySubstituted > 0 || new Date(original.cov_end).getTime() <= effective.getTime()) blocks.push("original_not_covering");
  if (staff.some((s) => s.membership_id === input.substituteMembershipId)) blocks.push("already_assigned");
  const sub = (await sql<{ status: string; internal_role: string | null; authorized: boolean }>`
    SELECT m.status, m.internal_role,
           EXISTS (SELECT 1 FROM establishment_worker_assignments e WHERE e.organization_worker_membership_id = m.id AND e.location_id = ${shift.location_id}
                     AND e.organization_id = m.organization_id AND e.archived_at IS NULL) AS authorized
    FROM organization_worker_memberships m WHERE m.id = ${input.substituteMembershipId} AND m.organization_id = ${organizationId}`.execute(trx)).rows[0];
  if (!sub) throw notFound();
  if (sub.status !== "active") blocks.push("substitute_inactive");
  // Elegibilidad y credenciales obligatorias: las mismas reglas de siempre.
  const eligibility = await evaluateWorkerEligibilityInTransaction(trx, organizationId, input.substituteMembershipId);
  if (eligibility.eligibilityStatus !== "eligible") blocks.push("not_eligible");
  // Puesto y funciones: el mismo puesto que la persona sustituida.
  if (original && (sub.internal_role ?? "") !== (original.internal_role ?? "")) blocks.push("role_mismatch");
  // Autorización en el establecimiento.
  if (!sub.authorized) blocks.push("not_authorized_in_establishment");
  // Solape real con otro turno (cobertura recortada por sus sustituciones; nocturnos y cambios de fecha incluidos).
  const busy = (await sql<{ busy: boolean }>`SELECT app_residential_membership_busy(${input.substituteMembershipId}::uuid, ${effective.toISOString()}::timestamptz,
    ${shift.scheduled_end}::timestamptz, ${shiftId}::uuid) AS busy`.execute(trx)).rows[0]?.busy;
  if (busy) blocks.push("schedule_overlap");
  // Disponibilidad declarada: solo advertencia.
  const unavailable = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM worker_unavailability_periods
    WHERE organization_worker_membership_id = ${input.substituteMembershipId} AND starts_at < ${shift.scheduled_end}::timestamptz
      AND ends_at > ${effective.toISOString()}::timestamptz`.execute(trx)).rows[0]?.n ?? 0;
  const sras = await shiftAssignments(trx, shiftId);
  const originalResidents = [...new Set(sras.filter((a) => a.membership_id === input.originalMembershipId && a.effective_until === null
    && coversFrom(a, staff, effective.getTime())).map((a) => a.care_recipient_id))];
  return { shift, at: effective, blocks, availabilityWarning: unavailable > 0, originalResidents, substituteRole: sub.internal_role, staff, sras };
}

export function previewSubstitution(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof substitutionPreviewSchema>, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    await requireBothFeatures(trx, organizationId);
    const e = await evaluateSubstitution(trx, organizationId, shiftId, input, now);
    return { effectiveAt: e.at.toISOString(), fullReplacement: e.at.getTime() <= new Date(e.shift.scheduled_start).getTime(), blocks: e.blocks,
      availabilityWarning: e.availabilityWarning, originalResidents: e.originalResidents };
  });
}

/** Sustituir: todo o nada. Los ponches y horas de la persona original se conservan; nada cambia hacia atrás. */
export function substitute(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof substitutionSchema>, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    await requireBothFeatures(trx, organizationId);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`residential-assign:${shiftId}`}))`.execute(trx);
    // 27-nov: como toda decisión de horario (Turnos, calendario, SmartMatch), la sustituta se serializa con el cerrojo de
    // su membresía DESPUÉS del del turno: dos decisiones a la vez sobre la misma persona ya no pasan las dos los
    // controles de solape, ni chocan al guardar su elegibilidad (antes daba 500).
    await lockWorkerSchedule(trx, input.substituteMembershipId);
    const e = await evaluateSubstitution(trx, organizationId, shiftId, input, now);
    if (e.blocks.length > 0) throw new AssignmentError("RESIDENTIAL_SUBSTITUTION_BLOCKED", 409, { blocks: e.blocks });
    if (e.availabilityWarning && !input.confirmAvailability) throw new AssignmentError("RESIDENTIAL_SUBSTITUTION_AVAILABILITY_CONFIRMATION_REQUIRED", 409);
    // Transferencias: solo residentes de la persona original, a la sustituta o a otra persona que cubra el turno a esa hora.
    const destinations = new Set([input.substituteMembershipId, ...e.staff.filter((s) => s.assignment_status === "accepted" && s.membership_id !== input.originalMembershipId
      && new Date(s.cov_start).getTime() <= e.at.getTime() && e.at.getTime() < new Date(s.cov_end).getTime()).map((s) => s.membership_id)]);
    for (const t of input.transfers) {
      if (!e.originalResidents.includes(t.careRecipientId)) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_NOT_FOUND", 409, { careRecipientId: t.careRecipientId });
      if (!destinations.has(t.toMembershipId)) throw new AssignmentError("RESIDENTIAL_ASSIGNMENT_STAFF_NOT_ASSIGNED", 409, { membershipId: t.toMembershipId });
    }
    const transferred = new Set(input.transfers.map((t) => t.careRecipientId));
    const uncovered = e.originalResidents.filter((r) => !transferred.has(r)
      && !e.sras.some((a) => a.care_recipient_id === r && a.membership_id !== input.originalMembershipId && coversFrom(a, e.staff, e.at.getTime())));
    if (uncovered.length > 0 && !(input.confirmUncovered && input.uncoveredReason)) {
      throw new AssignmentError("RESIDENTIAL_UNCOVERED_CONFIRMATION_REQUIRED", 409, { uncovered });
    }
    const id = (await sql<{ id: string }>`SELECT app_residential_substitute_shift(${shiftId}::uuid, ${e.shift.location_id}::uuid, ${input.originalMembershipId}::uuid,
      ${input.substituteMembershipId}::uuid, ${e.at.toISOString()}::timestamptz, ${input.reasonCode}, ${input.reasonNote ?? null}, ${e.availabilityWarning},
      ${e.availabilityWarning && input.confirmAvailability}, ${JSON.stringify(input.transfers)}::jsonb, ${JSON.stringify(uncovered)}::jsonb,
      ${uncovered.length > 0}, ${input.uncoveredReason ?? null}, ${e.shift.required_role}) AS id`.execute(trx)).rows[0].id;
    return { id, effectiveAt: e.at.toISOString(), fullReplacement: e.at.getTime() <= new Date(e.shift.scheduled_start).getTime(), transferred: input.transfers.length, uncovered };
  });
}

/**
 * 177 (F5): parte de asignaciones del panel (solo administración; el llamador ya comprobó el rol y el interruptor).
 * Un residente está sin cobertura ahora si su establecimiento tiene turnos en curso y ninguno lo cubre en este momento.
 */
export async function assignmentsPanelSection(trx: Trx, organizationId: string, now = new Date()) {
  const ongoing = (await sql<ShiftRow>`
    SELECT s.id, t.location_id, l.name AS location_name, s.scheduled_start, s.scheduled_end, s.status::text AS status, s.required_role
    FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id JOIN locations l ON l.id = t.location_id
    WHERE s.organization_id = ${organizationId} AND s.status::text <> 'cancelled' AND l.archived_at IS NULL
      AND s.scheduled_start <= ${now.toISOString()}::timestamptz AND s.scheduled_end > ${now.toISOString()}::timestamptz
    ORDER BY l.name, s.scheduled_start, s.id`.execute(trx)).rows;
  const byLocation = new Map<string, { name: string; residents: Map<string, { name: string; covered: boolean }> }>();
  for (const sh of ongoing) {
    const b = await board(trx, organizationId, sh, now);
    const loc = byLocation.get(sh.location_id) ?? { name: sh.location_name, residents: new Map() };
    for (const r of b.residents) {
      const prev = loc.residents.get(r.id);
      loc.residents.set(r.id, { name: r.name, covered: (prev?.covered ?? false) || !r.uncovered });
    }
    byLocation.set(sh.location_id, loc);
  }
  const uncovered = [...byLocation.values()].flatMap((l) => [...l.residents.entries()].filter(([, r]) => !r.covered)
    .map(([id, r]) => ({ careRecipientId: id, name: r.name, establishment: l.name })));
  const alerts = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM shift_coverage_alerts WHERE organization_id = ${organizationId} AND resolved_at IS NULL`.execute(trx)).rows[0]?.n ?? 0;
  return { ongoingShifts: ongoing.length, uncovered, openCoverageAlerts: alerts };
}

/**
 * 177 (F5): informe de asignaciones de un establecimiento en un rango de días locales (máximo 31). Por turno: personal,
 * residentes atendidos, periodos, sustituciones y alertas de cobertura; con el detalle de sustituciones y alertas.
 */
export async function assignmentsReportIn(trx: Trx, organizationId: string, locationId: string, range: { from: string; to: string; days: number }) {
  {
    const loc = (await sql<{ id: string; name: string }>`SELECT l.id, l.name FROM locations l JOIN establishment_technical_rooms t ON t.location_id = l.id
      WHERE l.id = ${locationId} AND l.organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!loc) throw notFound();
    const shifts = (await sql<{ id: string; scheduled_start: string; scheduled_end: string; status: string; staff: number; residents: number; periods: number;
      substitutions: number; alerts: number }>`
      SELECT s.id, s.scheduled_start, s.scheduled_end, s.status::text AS status,
             (SELECT count(*)::int FROM assignments a WHERE a.shift_id = s.id AND a.response_status = 'accepted') AS staff,
             (SELECT count(DISTINCT x.care_recipient_id)::int FROM shift_resident_assignments x WHERE x.shift_id = s.id) AS residents,
             (SELECT count(*)::int FROM shift_resident_assignments x WHERE x.shift_id = s.id) AS periods,
             (SELECT count(*)::int FROM shift_substitutions x WHERE x.shift_id = s.id) AS substitutions,
             (SELECT count(*)::int FROM shift_coverage_alerts x WHERE x.shift_id = s.id) AS alerts
      FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id AND t.location_id = ${locationId}
      WHERE s.organization_id = ${organizationId}
        AND s.scheduled_start >= (${range.from}::date::timestamp AT TIME ZONE 'America/Puerto_Rico')
        AND s.scheduled_start < ((${range.from}::date + ${range.days}::int)::timestamp AT TIME ZONE 'America/Puerto_Rico')
      ORDER BY s.scheduled_start, s.id`.execute(trx)).rows;
    const ids = shifts.map((x) => x.id);
    const subs = ids.length === 0 ? [] : (await sql<{ shift_id: string; original: string | null; substitute: string | null; effective_at: string; full_replacement: boolean;
      reason_code: string; availability_warning: boolean; uncovered: number; created_by: string | null }>`
      SELECT x.shift_id, wo.display_name AS original, ws.display_name AS substitute, x.effective_at, x.full_replacement, x.reason_code, x.availability_warning,
             jsonb_array_length(x.uncovered) AS uncovered, u.email AS created_by
      FROM shift_substitutions x
      JOIN organization_worker_memberships mo ON mo.id = x.original_membership_id JOIN workers wo ON wo.id = mo.worker_id
      JOIN organization_worker_memberships ms ON ms.id = x.substitute_membership_id JOIN workers ws ON ws.id = ms.worker_id
      LEFT JOIN users u ON u.id = x.created_by_user_id
      WHERE x.shift_id = ANY(${ids}::uuid[]) ORDER BY x.effective_at, x.id`.execute(trx)).rows;
    const alerts = ids.length === 0 ? [] : (await sql<{ shift_id: string; resident: string; uncovered_from: string; reason: string; resolved_at: string | null }>`
      SELECT a.shift_id, COALESCE(NULLIF(cr.preferred_name, ''), cr.first_name || ' ' || cr.last_name) AS resident, a.uncovered_from, a.reason, a.resolved_at
      FROM shift_coverage_alerts a JOIN care_recipients cr ON cr.id = a.care_recipient_id
      WHERE a.shift_id = ANY(${ids}::uuid[]) ORDER BY a.uncovered_from, a.id`.execute(trx)).rows;
    return {
      establishment: { id: loc.id, name: loc.name }, from: range.from, to: range.to, days: range.days,
      shifts: shifts.map((x) => ({ shiftId: x.id, scheduledStart: x.scheduled_start, scheduledEnd: x.scheduled_end, status: x.status, staff: x.staff,
        residents: x.residents, periods: x.periods, substitutions: x.substitutions, coverageAlerts: x.alerts })),
      substitutions: subs.map((x) => ({ shiftId: x.shift_id, original: x.original, substitute: x.substitute, effectiveAt: x.effective_at, fullReplacement: x.full_replacement,
        reasonCode: x.reason_code, availabilityWarning: x.availability_warning, uncoveredCount: x.uncovered, createdBy: x.created_by })),
      coverageAlerts: alerts.map((a) => ({ shiftId: a.shift_id, resident: a.resident, uncoveredFrom: a.uncovered_from, reason: a.reason, resolvedAt: a.resolved_at })),
      totals: { shifts: shifts.length, cancelled: shifts.filter((x) => x.status === "cancelled").length, substitutions: subs.length, coverageAlerts: alerts.length,
        openCoverageAlerts: alerts.filter((a) => !a.resolved_at).length },
    };
  }
}

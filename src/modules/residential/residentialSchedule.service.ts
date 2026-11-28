import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import {
  assignWorkerToShiftInTransaction, DuplicateAssignmentError, MembershipNotInOrgError, ScheduleConflictError,
  SelfDeclarationConfirmationRequiredError, WorkerNotEligibleError,
} from "../assignments/assignments.service.js";
import { ResidentialError, RESIDENTIAL_MANAGER_REQUIRED, RESIDENTIAL_NOT_FOUND } from "./residentialErrors.js";
import type { applyTemplateSchema, copyWeekSchema, createEntrySchema, createTemplateSchema, updateEntrySchema, updateTemplateSchema } from "./residentialSchedule.schemas.js";
import { isMonday } from "./residentialSchedule.schemas.js";
import { addDays, scheduleSummary, scheduleWarnings, type ScheduleEntryLike } from "./residentialScheduleModel.js";

/**
 * 172 · Hogares F2: calendario semanal del establecimiento.
 *
 * Solo hogares (residentialGate), solo con HOGAR_CALENDARIO encendido (orgFeatureGate) y solo administración del hogar.
 * En borrador las entradas no son turnos y nadie del personal las ve. Al publicar, cada entrada nueva se convierte en un
 * turno real sobre la habitación técnica del establecimiento y, si tiene persona, en su asignación con las reglas de
 * siempre (elegibilidad, sin duplicados ni solapes). Ninguna respuesta incluye la habitación técnica: los turnos se
 * presentan como del establecimiento (docs/RESIDENTIAL_TECHNICAL_ROOM.md).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trx = Transaction<any>;
const TZ = "America/Puerto_Rico";

/** Error de negocio con detalle (las entradas implicadas) para el portal. */
export class ResidentialScheduleError extends ResidentialError {
  constructor(code: string, status: number, public readonly details?: Record<string, unknown>) { super(code, status); }
}

async function requireManager(trx: Trx): Promise<void> {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new ResidentialError(RESIDENTIAL_MANAGER_REQUIRED, 403);
}
const manage = <T>(userId: string, organizationId: string, fn: (trx: Trx) => Promise<T>) =>
  withTenantContext({ userId, organizationId }, async (trx) => { await requireManager(trx); return fn(trx); });
const notFound = () => new ResidentialError(RESIDENTIAL_NOT_FOUND, 404);
function requireMonday(weekStart: string) {
  if (!isMonday(weekStart)) throw new ResidentialError("RESIDENTIAL_SCHEDULE_WEEK_START_INVALID", 400);
}

async function activeEstablishment(trx: Trx, organizationId: string, locationId: string) {
  // Auditoría F2 (26-nov): bloquea el establecimiento en modo compartido (el mismo bloqueo de la 171 que el cierre toma
  // en exclusiva). Publicar o editar el calendario y cerrar el establecimiento no pueden cruzarse: si el cierre va
  // primero, esto espera y ve el establecimiento cerrado; si va después, el cierre espera y ve los turnos creados.
  const lock = await sql<{ open: boolean | null }>`SELECT app_residential_lock_establishment(${locationId}::uuid) AS open`.execute(trx);
  if (lock.rows[0]?.open !== true) throw notFound();
  const r = await sql<{ id: string; name: string }>`
    SELECT l.id, l.name FROM locations l
    WHERE l.id = ${locationId} AND l.organization_id = ${organizationId} AND l.archived_at IS NULL`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

async function technicalRoom(trx: Trx, locationId: string): Promise<string> {
  const r = await sql<{ room_id: string }>`SELECT room_id FROM establishment_technical_rooms WHERE location_id = ${locationId}`.execute(trx);
  if (!r.rows[0]) throw new ResidentialError("RESIDENTIAL_ESTABLISHMENT_CLOSED", 409);
  return r.rows[0].room_id;
}

type WeekRow = { id: string; status: "draft" | "published"; version: number; has_unpublished_changes: boolean; published_at: string | null };
async function findWeek(trx: Trx, organizationId: string, locationId: string, weekStart: string, lock = false): Promise<WeekRow | null> {
  const r = await sql<WeekRow>`
    SELECT id, status, version, has_unpublished_changes, published_at FROM schedule_weeks
    WHERE organization_id = ${organizationId} AND location_id = ${locationId} AND week_start = ${weekStart}::date
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(trx);
  return r.rows[0] ?? null;
}
async function ensureWeek(trx: Trx, organizationId: string, locationId: string, weekStart: string): Promise<WeekRow> {
  await sql`
    INSERT INTO schedule_weeks (organization_id, location_id, week_start) VALUES (${organizationId}, ${locationId}, ${weekStart}::date)
    ON CONFLICT (organization_id, location_id, week_start) DO NOTHING`.execute(trx);
  return (await findWeek(trx, organizationId, locationId, weekStart, true))!;
}
async function markChanged(trx: Trx, weekId: string) {
  await sql`UPDATE schedule_weeks SET has_unpublished_changes = true WHERE id = ${weekId} AND status = 'published'`.execute(trx);
}

async function requireActiveMembership(trx: Trx, organizationId: string, membershipId: string | null | undefined) {
  if (!membershipId) return;
  const r = await sql<{ id: string }>`
    SELECT id FROM organization_worker_memberships WHERE id = ${membershipId} AND organization_id = ${organizationId} AND status = 'active'`.execute(trx);
  if (!r.rows[0]) throw new ResidentialError("RESIDENTIAL_SCHEDULE_STAFF_NOT_ACTIVE", 409);
}

type EntryRow = {
  id: string; starts_local: string; ends_local: string; starts_at: string; ends_at: string; required_role: string;
  membership_id: string | null; worker_name: string | null; label: string | null; shift_id: string | null;
  removed_at: string | null; shift_status: string | null; assignment_status: string | null;
  substitute_name?: string | null; substitution_at?: string | null;
};
async function weekEntries(trx: Trx, weekId: string): Promise<EntryRow[]> {
  const r = await sql<EntryRow>`
    SELECT e.id,
           to_char(e.starts_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
           to_char(e.ends_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS ends_local,
           e.starts_at, e.ends_at, e.required_role, e.organization_worker_membership_id AS membership_id,
           w.display_name AS worker_name, e.label, e.shift_id, e.removed_at, s.status::text AS shift_status,
           (SELECT a.response_status::text FROM assignments a WHERE a.shift_id = e.shift_id AND a.response_status IN ('pending', 'accepted')
             ORDER BY a.created_at DESC LIMIT 1) AS assignment_status,
           -- 176 (F3): última sustitución administrativa del turno (quién cubre y desde cuándo).
           (SELECT sw.display_name FROM shift_substitutions x JOIN organization_worker_memberships sm ON sm.id = x.substitute_membership_id
              JOIN workers sw ON sw.id = sm.worker_id WHERE x.shift_id = e.shift_id ORDER BY x.created_at DESC LIMIT 1) AS substitute_name,
           (SELECT to_char(x.effective_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') FROM shift_substitutions x WHERE x.shift_id = e.shift_id
              ORDER BY x.created_at DESC LIMIT 1) AS substitution_at
    FROM schedule_week_shifts e
    LEFT JOIN organization_worker_memberships m ON m.id = e.organization_worker_membership_id
    LEFT JOIN workers w ON w.id = m.worker_id
    LEFT JOIN shifts s ON s.id = e.shift_id
    WHERE e.week_id = ${weekId}
    ORDER BY e.starts_at, e.created_at, e.id`.execute(trx);
  return r.rows;
}
const asModel = (e: EntryRow): ScheduleEntryLike => ({
  id: e.id, startsAt: new Date(e.starts_at), endsAt: new Date(e.ends_at), membershipId: e.membership_id, requiredRole: e.required_role,
});
const presentEntry = (e: EntryRow) => ({
  id: e.id, startsAt: e.starts_local, endsAt: e.ends_local,
  durationMinutes: Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60_000),
  requiredRole: e.required_role, membershipId: e.membership_id, workerName: e.worker_name, label: e.label,
  published: e.shift_id !== null, removed: e.removed_at !== null,
  shiftStatus: e.shift_status, assignmentStatus: e.assignment_status,
  substitution: e.substitute_name ? { substituteName: e.substitute_name, effectiveAt: e.substitution_at ?? null } : null,
});

/**
 * Decisión de Rafa (27-nov): los turnos individuales (creados desde «Turnos») y la planificación semanal están
 * sincronizados. La semana muestra, solo lectura, los turnos vigentes del establecimiento que NO vienen del calendario
 * (de la habitación técnica, de sus habitaciones o de sus residentes); cuentan en las horas y entran en los avisos de
 * solape y duplicado, así que publicar nunca crea un segundo turno para la misma persona y franja. Los turnos que creó
 * el calendario aparecen una sola vez (como entradas), nunca también como individuales.
 */
type IndividualRow = {
  id: string; starts_local: string; ends_local: string; starts_at: string; ends_at: string; status: string; required_role: string;
  target: "establishment" | "room" | "resident"; room_name: string | null; resident_name: string | null;
  membership_id: string | null; worker_name: string | null; assignment_status: string | null;
};
async function individualShifts(trx: Trx, organizationId: string, locationId: string, weekStart: string): Promise<IndividualRow[]> {
  const r = await sql<IndividualRow>`
    SELECT s.id,
           to_char(s.scheduled_start AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
           to_char(s.scheduled_end AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS ends_local,
           s.scheduled_start AS starts_at, s.scheduled_end AS ends_at, s.status::text AS status, s.required_role,
           CASE WHEN app_is_technical_room(s.room_id) THEN 'establishment' WHEN s.room_id IS NOT NULL THEN 'room' ELSE 'resident' END AS target,
           CASE WHEN s.room_id IS NOT NULL AND NOT app_is_technical_room(s.room_id) THEN rm.name END AS room_name,
           CASE WHEN s.care_recipient_id IS NOT NULL THEN btrim(concat_ws(' ', cr.first_name, cr.last_name)) END AS resident_name,
           a.organization_worker_membership_id AS membership_id, w.display_name AS worker_name, a.response_status::text AS assignment_status
    FROM shifts s
    LEFT JOIN rooms rm ON rm.id = s.room_id
    LEFT JOIN units un ON un.id = rm.unit_id
    LEFT JOIN care_recipients cr ON cr.id = s.care_recipient_id
    LEFT JOIN LATERAL (SELECT a.organization_worker_membership_id, a.response_status FROM assignments a
                       WHERE a.shift_id = s.id AND a.response_status IN ('pending', 'accepted') ORDER BY a.created_at DESC LIMIT 1) a ON true
    LEFT JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
    LEFT JOIN workers w ON w.id = m.worker_id
    WHERE s.organization_id = ${organizationId}
      AND s.status <> 'cancelled'
      AND s.scheduled_start < ((${weekStart}::date + 7)::timestamp AT TIME ZONE ${TZ})
      AND s.scheduled_end > (${weekStart}::date::timestamp AT TIME ZONE ${TZ})
      AND (un.location_id = ${locationId} OR (s.room_id IS NULL AND cr.location_id = ${locationId}))
      AND NOT EXISTS (SELECT 1 FROM schedule_week_shifts e WHERE e.shift_id = s.id)
    ORDER BY s.scheduled_start, s.id`.execute(trx);
  return r.rows;
}
const individualModel = (i: IndividualRow): ScheduleEntryLike => ({
  id: `shift:${i.id}`, startsAt: new Date(i.starts_at), endsAt: new Date(i.ends_at), membershipId: i.membership_id, requiredRole: i.required_role,
});
const presentIndividual = (i: IndividualRow) => ({
  shiftId: i.id, startsAt: i.starts_local, endsAt: i.ends_local,
  durationMinutes: Math.round((new Date(i.ends_at).getTime() - new Date(i.starts_at).getTime()) / 60_000),
  target: i.target, roomName: i.room_name, residentName: i.resident_name, requiredRole: i.required_role,
  membershipId: i.membership_id, workerName: i.worker_name, assignmentStatus: i.assignment_status, shiftStatus: i.status,
});
/** Avisos del calendario contando los turnos individuales; solo los que afectan a alguna entrada del calendario. */
function weekWarnings(active: EntryRow[], individual: IndividualRow[]) {
  return scheduleWarnings([...active.map(asModel), ...individual.map(individualModel)])
    .filter((w) => w.entryIds.some((id) => !id.startsWith("shift:")))
    .map((w) => ({ ...w, entryIds: w.entryIds.filter((id) => !id.startsWith("shift:")), shiftIds: w.entryIds.filter((id) => id.startsWith("shift:")).map((id) => id.slice(6)) }));
}

export function listScheduleEstablishments(userId: string, organizationId: string) {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string; name: string }>`
      SELECT l.id, l.name FROM locations l
      WHERE l.organization_id = ${organizationId} AND l.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.location_id = l.id)
      ORDER BY l.name, l.id`.execute(trx);
    return r.rows;
  });
}

export function getScheduleWeek(userId: string, organizationId: string, locationId: string, weekStart: string) {
  requireMonday(weekStart);
  return manage(userId, organizationId, async (trx) => {
    const establishment = await activeEstablishment(trx, organizationId, locationId);
    const week = await findWeek(trx, organizationId, locationId, weekStart);
    const rows = week ? await weekEntries(trx, week.id) : [];
    const active = rows.filter((e) => e.removed_at === null && e.shift_status !== "cancelled");
    const staff = await sql<{ membership_id: string; name: string | null; role: string | null; eligibility: string | null }>`
      SELECT m.id AS membership_id, w.display_name AS name, m.internal_role AS role,
             (SELECT we.eligibility_status::text FROM worker_eligibility we WHERE we.organization_worker_membership_id = m.id
               ORDER BY we.computed_at DESC LIMIT 1) AS eligibility
      FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
      WHERE m.organization_id = ${organizationId} AND m.status = 'active'
      ORDER BY w.display_name, m.id`.execute(trx);
    const individual = await individualShifts(trx, organizationId, locationId, weekStart);
    // Las horas incluyen los turnos individuales; «sin persona» sigue contando solo entradas del calendario.
    const summary = { ...scheduleSummary([...active.map(asModel), ...individual.map(individualModel)]), unassignedEntries: active.filter((e) => !e.membership_id).length };
    return {
      establishment,
      week: {
        weekStart, status: week ? week.status : "empty", version: week?.version ?? 0,
        hasUnpublishedChanges: week ? (week.status === "draft" ? rows.length > 0 : week.has_unpublished_changes) : false,
        publishedAt: week?.published_at ?? null,
      },
      entries: rows.filter((e) => e.shift_status !== "cancelled" || e.removed_at === null).map(presentEntry),
      staff: staff.rows.map((s) => ({ membershipId: s.membership_id, name: s.name, role: s.role, eligibility: s.eligibility ?? "unknown" })),
      individualShifts: individual.map(presentIndividual),
      summary,
      warnings: weekWarnings(active, individual),
    };
  });
}

type CreateEntry = z.infer<typeof createEntrySchema>;
async function insertEntry(trx: Trx, userId: string, organizationId: string, weekId: string, input: CreateEntry) {
  await requireActiveMembership(trx, organizationId, input.membershipId);
  const r = await sql<{ id: string }>`
    INSERT INTO schedule_week_shifts (week_id, organization_id, starts_at, ends_at, required_role, organization_worker_membership_id, label, created_by_user_id)
    VALUES (${weekId}, ${organizationId}, (${input.startsAt}::timestamp AT TIME ZONE ${TZ}),
            (${input.startsAt}::timestamp AT TIME ZONE ${TZ}) + make_interval(mins => ${input.durationMinutes}),
            ${input.requiredRole ?? "Cuidador/a"}, ${input.membershipId ?? null}, ${input.label ?? null}, ${userId})
    RETURNING id`.execute(trx);
  return r.rows[0].id;
}

export function createScheduleEntry(userId: string, organizationId: string, locationId: string, weekStart: string, input: CreateEntry) {
  requireMonday(weekStart);
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const week = await ensureWeek(trx, organizationId, locationId, weekStart);
    const id = await insertEntry(trx, userId, organizationId, week.id, input);
    await markChanged(trx, week.id);
    return { id };
  });
}

async function entryWithWeek(trx: Trx, organizationId: string, entryId: string) {
  const r = await sql<{ id: string; week_id: string; shift_id: string | null; removed_at: string | null; starts_local: string; minutes: number; required_role: string; membership_id: string | null; label: string | null; location_id: string }>`
    SELECT e.id, e.week_id, e.shift_id, e.removed_at,
           to_char(e.starts_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
           (extract(epoch FROM e.ends_at - e.starts_at) / 60)::int AS minutes, e.required_role,
           e.organization_worker_membership_id AS membership_id, e.label, w.location_id
    FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id = e.week_id
    WHERE e.id = ${entryId} AND e.organization_id = ${organizationId} FOR UPDATE OF e`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

/**
 * Cambiar una entrada. En borrador se modifica. Si ya está publicada (tiene turno) no se toca: se marca para quitar y
 * se crea una entrada nueva con los cambios; al volver a publicar se cancela el turno anterior y se crea el nuevo.
 */
export function updateScheduleEntry(userId: string, organizationId: string, entryId: string, input: z.infer<typeof updateEntrySchema>) {
  return manage(userId, organizationId, async (trx) => {
    const e = await entryWithWeek(trx, organizationId, entryId);
    if (e.removed_at) throw new ResidentialError("RESIDENTIAL_SCHEDULE_PUBLISHED_ENTRY", 409);
    await activeEstablishment(trx, organizationId, e.location_id);
    const next: CreateEntry = {
      startsAt: input.startsAt ?? e.starts_local, durationMinutes: input.durationMinutes ?? e.minutes,
      requiredRole: input.requiredRole ?? e.required_role,
      membershipId: input.membershipId === undefined ? e.membership_id : input.membershipId,
      label: input.label === undefined ? e.label : input.label,
    };
    if (e.shift_id === null) {
      await requireActiveMembership(trx, organizationId, next.membershipId);
      await sql`
        UPDATE schedule_week_shifts SET starts_at = (${next.startsAt}::timestamp AT TIME ZONE ${TZ}),
          ends_at = (${next.startsAt}::timestamp AT TIME ZONE ${TZ}) + make_interval(mins => ${next.durationMinutes}),
          required_role = ${next.requiredRole ?? "Cuidador/a"}, organization_worker_membership_id = ${next.membershipId ?? null}, label = ${next.label ?? null}
        WHERE id = ${entryId}`.execute(trx);
      await markChanged(trx, e.week_id);
      return { id: entryId, replaced: false };
    }
    await sql`UPDATE schedule_week_shifts SET removed_at = now() WHERE id = ${entryId}`.execute(trx);
    const id = await insertEntry(trx, userId, organizationId, e.week_id, next);
    await markChanged(trx, e.week_id);
    return { id, replaced: true };
  });
}

/** Quitar una entrada: en borrador se borra; publicada, se marca y su turno se cancela al volver a publicar. */
export function removeScheduleEntry(userId: string, organizationId: string, entryId: string) {
  return manage(userId, organizationId, async (trx) => {
    const e = await entryWithWeek(trx, organizationId, entryId);
    if (e.shift_id === null) await sql`DELETE FROM schedule_week_shifts WHERE id = ${entryId}`.execute(trx);
    else if (!e.removed_at) await sql`UPDATE schedule_week_shifts SET removed_at = now() WHERE id = ${entryId}`.execute(trx);
    await markChanged(trx, e.week_id);
    return { id: entryId, removed: true };
  });
}

/** Copiar otra semana: solo a una semana sin entradas vigentes. Conserva horas, puestos y personas previstas. */
export function copyScheduleWeek(userId: string, organizationId: string, locationId: string, weekStart: string, input: z.infer<typeof copyWeekSchema>) {
  requireMonday(weekStart); requireMonday(input.fromWeekStart);
  if (input.fromWeekStart === weekStart) throw new ResidentialError("INVALID_INPUT", 400);
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const source = await findWeek(trx, organizationId, locationId, input.fromWeekStart);
    if (!source) throw notFound();
    const week = await ensureWeek(trx, organizationId, locationId, weekStart);
    const existing = (await weekEntries(trx, week.id)).filter((e) => e.removed_at === null && e.shift_status !== "cancelled");
    if (existing.length > 0) throw new ResidentialError("RESIDENTIAL_SCHEDULE_WEEK_NOT_EMPTY", 409);
    const days = Math.round((Date.parse(`${weekStart}T12:00:00Z`) - Date.parse(`${input.fromWeekStart}T12:00:00Z`)) / 86_400_000);
    const rows = (await weekEntries(trx, source.id)).filter((e) => e.removed_at === null && e.shift_status !== "cancelled");
    let copied = 0;
    for (const e of rows) {
      const [d, t] = e.starts_local.split("T");
      const minutes = Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60_000);
      const active = e.membership_id
        ? (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM organization_worker_memberships WHERE id = ${e.membership_id} AND status = 'active') AS ok`.execute(trx)).rows[0].ok
        : false;
      await insertEntry(trx, userId, organizationId, week.id, {
        startsAt: `${addDays(d, days)}T${t}`, durationMinutes: minutes, requiredRole: e.required_role,
        membershipId: active ? e.membership_id : null, label: e.label,
      });
      copied++;
    }
    await markChanged(trx, week.id);
    return { copied };
  });
}

/** Aplicar una plantilla: añade sus plazas a la semana (una entrada sin persona por plaza). */
export function applyScheduleTemplate(userId: string, organizationId: string, locationId: string, weekStart: string, input: z.infer<typeof applyTemplateSchema>) {
  requireMonday(weekStart);
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const tpl = await sql<{ id: string }>`
      SELECT id FROM schedule_templates WHERE id = ${input.templateId} AND organization_id = ${organizationId}
        AND location_id = ${locationId} AND archived_at IS NULL`.execute(trx);
    if (!tpl.rows[0]) throw notFound();
    const slots = await sql<{ weekday: number; start_time: string; duration_minutes: number; required_role: string; headcount: number; label: string | null }>`
      SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, duration_minutes, required_role, headcount, label
      FROM schedule_template_slots WHERE template_id = ${input.templateId} ORDER BY weekday, start_time`.execute(trx);
    const week = await ensureWeek(trx, organizationId, locationId, weekStart);
    let added = 0;
    for (const s of slots.rows) for (let i = 0; i < s.headcount; i++) {
      await insertEntry(trx, userId, organizationId, week.id, {
        startsAt: `${addDays(weekStart, s.weekday - 1)}T${s.start_time}`, durationMinutes: s.duration_minutes, requiredRole: s.required_role, membershipId: null, label: s.label,
      });
      added++;
    }
    await markChanged(trx, week.id);
    return { added };
  });
}

/**
 * Publicar: crea los turnos de las entradas nuevas (y sus asignaciones con las reglas de siempre), cancela los de las
 * entradas quitadas, guarda la versión y avisa al personal afectado con un aviso general (sin nombres ni datos de
 * residentes). Todo o nada: si una asignación no cumple las reglas, no se publica nada y se indica qué entrada falla.
 */
export function publishScheduleWeek(userId: string, organizationId: string, locationId: string, weekStart: string) {
  requireMonday(weekStart);
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const week = await findWeek(trx, organizationId, locationId, weekStart, true);
    if (!week) throw new ResidentialError("RESIDENTIAL_SCHEDULE_NOTHING_TO_PUBLISH", 409);
    const rows = await weekEntries(trx, week.id);
    const toCancel = rows.filter((e) => e.removed_at !== null && e.shift_status !== "cancelled");
    const toCreate = rows.filter((e) => e.shift_id === null);
    if (week.status === "published" && !week.has_unpublished_changes && toCancel.length === 0 && toCreate.length === 0) {
      throw new ResidentialError("RESIDENTIAL_SCHEDULE_NOTHING_TO_PUBLISH", 409);
    }
    const active = rows.filter((e) => e.removed_at === null && e.shift_status !== "cancelled");
    const warnings = weekWarnings(active, await individualShifts(trx, organizationId, locationId, weekStart));
    if (warnings.length > 0) throw new ResidentialScheduleError("RESIDENTIAL_SCHEDULE_OVERLAP", 409, { warnings });
    const past = toCreate.filter((e) => new Date(e.starts_at).getTime() <= Date.now());
    if (past.length > 0) throw new ResidentialScheduleError("RESIDENTIAL_SCHEDULE_IN_PAST", 409, { entryIds: past.map((e) => e.id) });

    const notifyUsers = new Set<string>();
    const affectedUsers = async (shiftId: string) => {
      const r = await sql<{ user_id: string }>`
        SELECT w.user_id FROM assignments a JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
        JOIN workers w ON w.id = m.worker_id
        WHERE a.shift_id = ${shiftId} AND a.response_status IN ('pending', 'accepted') AND w.user_id IS NOT NULL`.execute(trx);
      for (const row of r.rows) notifyUsers.add(row.user_id);
    };

    let cancelled = 0;
    for (const e of toCancel) {
      const r = await sql<{ id: string }>`
        UPDATE shifts SET status = 'cancelled', updated_at = now()
        WHERE id = ${e.shift_id} AND organization_id = ${organizationId} AND status IN ('unassigned', 'confirmed') AND scheduled_start > now()
        RETURNING id`.execute(trx);
      if (!r.rows[0]) throw new ResidentialScheduleError("RESIDENTIAL_SCHEDULE_SHIFT_STARTED", 409, { entryIds: [e.id] });
      await affectedUsers(e.shift_id!);
      cancelled++;
    }

    const room = await technicalRoom(trx, locationId);
    let created = 0;
    for (const e of toCreate) {
      const shift = await sql<{ id: string }>`
        INSERT INTO shifts (organization_id, care_recipient_id, room_id, scheduled_start, scheduled_end, required_role)
        VALUES (${organizationId}, NULL, ${room}, ${e.starts_at}::timestamptz, ${e.ends_at}::timestamptz, ${e.required_role})
        RETURNING id`.execute(trx);
      const shiftId = shift.rows[0].id;
      await sql`UPDATE schedule_week_shifts SET shift_id = ${shiftId} WHERE id = ${e.id}`.execute(trx);
      if (e.membership_id) {
        try {
          await assignWorkerToShiftInTransaction(trx, organizationId, shiftId, { organizationWorkerMembershipId: e.membership_id });
        } catch (error) {
          const code = error instanceof WorkerNotEligibleError || error instanceof SelfDeclarationConfirmationRequiredError ? "RESIDENTIAL_SCHEDULE_STAFF_NOT_ELIGIBLE"
            : error instanceof ScheduleConflictError || error instanceof DuplicateAssignmentError ? "RESIDENTIAL_SCHEDULE_STAFF_CONFLICT"
            : error instanceof MembershipNotInOrgError ? "RESIDENTIAL_SCHEDULE_STAFF_NOT_ACTIVE" : null;
          if (code) throw new ResidentialScheduleError(code, 409, { entryIds: [e.id], membershipId: e.membership_id });
          throw error;
        }
        await affectedUsers(shiftId);
      }
      created++;
    }

    const version = week.version + 1;
    await sql`
      UPDATE schedule_weeks SET status = 'published', version = ${version}, has_unpublished_changes = false,
        published_at = now(), published_by_user_id = ${userId}
      WHERE id = ${week.id}`.execute(trx);
    const current = (await weekEntries(trx, week.id)).filter((e) => e.removed_at === null && e.shift_status !== "cancelled");
    const snapshot = current.map((e) => ({ shiftId: e.shift_id, startsAt: e.starts_at, endsAt: e.ends_at, requiredRole: e.required_role, membershipId: e.membership_id }));
    await sql`
      INSERT INTO schedule_week_publications (week_id, organization_id, version, published_by_user_id, shifts_created, shifts_cancelled, shift_count, snapshot)
      VALUES (${week.id}, ${organizationId}, ${version}, ${userId}, ${created}, ${cancelled}, ${current.length}, ${JSON.stringify(snapshot)}::jsonb)`.execute(trx);
    // Aviso general a todo el personal con turno en la semana (y a quien perdió uno): sin nombres ni datos de residentes.
    for (const e of current) if (e.shift_id && e.membership_id) await affectedUsers(e.shift_id);
    const type = version === 1 ? "SCHEDULE_WEEK_PUBLISHED" : "SCHEDULE_WEEK_UPDATED";
    for (const user of notifyUsers) {
      await sql`
        INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
        VALUES (${user}, ${organizationId}, ${type}, 'schedule_week', ${week.id}, 'in_app', 'sent', now())`.execute(trx);
    }
    return { version, shiftsCreated: created, shiftsCancelled: cancelled, shiftCount: current.length, notified: notifyUsers.size };
  });
}

export function listSchedulePublications(userId: string, organizationId: string, locationId: string, weekStart: string) {
  requireMonday(weekStart);
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const r = await sql<{ version: number; published_at: string; actor_email: string | null; shifts_created: number; shifts_cancelled: number; shift_count: number }>`
      SELECT p.version, p.published_at, u.email AS actor_email, p.shifts_created, p.shifts_cancelled, p.shift_count
      FROM schedule_week_publications p JOIN schedule_weeks w ON w.id = p.week_id
      LEFT JOIN users u ON u.id = p.published_by_user_id
      WHERE w.organization_id = ${organizationId} AND w.location_id = ${locationId} AND w.week_start = ${weekStart}::date
      ORDER BY p.version DESC`.execute(trx);
    return r.rows.map((p) => ({ version: p.version, publishedAt: p.published_at, actorEmail: p.actor_email, shiftsCreated: p.shifts_created, shiftsCancelled: p.shifts_cancelled, shiftCount: p.shift_count }));
  });
}

// ---- Plantillas ------------------------------------------------------------------------------------------------------
type Slot = z.infer<typeof createTemplateSchema>["slots"][number];
async function replaceSlots(trx: Trx, organizationId: string, templateId: string, slots: Slot[]) {
  await sql`DELETE FROM schedule_template_slots WHERE template_id = ${templateId}`.execute(trx);
  for (const s of slots) {
    await sql`
      INSERT INTO schedule_template_slots (template_id, organization_id, weekday, start_time, duration_minutes, required_role, headcount, label)
      VALUES (${templateId}, ${organizationId}, ${s.weekday}, ${s.startTime}::time, ${s.durationMinutes}, ${s.requiredRole ?? "Cuidador/a"}, ${s.headcount ?? 1}, ${s.label ?? null})`.execute(trx);
  }
}
async function templatesOf(trx: Trx, organizationId: string, locationId: string) {
  const t = await sql<{ id: string; name: string; archived_at: string | null }>`
    SELECT id, name, archived_at FROM schedule_templates WHERE organization_id = ${organizationId} AND location_id = ${locationId}
    ORDER BY archived_at NULLS FIRST, name, id`.execute(trx);
  const slots = await sql<{ template_id: string; weekday: number; start_time: string; duration_minutes: number; required_role: string; headcount: number; label: string | null }>`
    SELECT s.template_id, s.weekday, to_char(s.start_time, 'HH24:MI') AS start_time, s.duration_minutes, s.required_role, s.headcount, s.label
    FROM schedule_template_slots s JOIN schedule_templates t ON t.id = s.template_id
    WHERE t.organization_id = ${organizationId} AND t.location_id = ${locationId} ORDER BY s.weekday, s.start_time`.execute(trx);
  return t.rows.map((x) => ({
    id: x.id, name: x.name, archived: x.archived_at !== null,
    slots: slots.rows.filter((s) => s.template_id === x.id).map((s) => ({
      weekday: s.weekday, startTime: s.start_time, durationMinutes: s.duration_minutes, requiredRole: s.required_role, headcount: s.headcount, label: s.label,
    })),
  }));
}
export function listScheduleTemplates(userId: string, organizationId: string, locationId: string) {
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    return templatesOf(trx, organizationId, locationId);
  });
}
export function createScheduleTemplate(userId: string, organizationId: string, locationId: string, input: z.infer<typeof createTemplateSchema>) {
  return manage(userId, organizationId, async (trx) => {
    await activeEstablishment(trx, organizationId, locationId);
    const r = await sql<{ id: string }>`
      INSERT INTO schedule_templates (organization_id, location_id, name, created_by_user_id) VALUES (${organizationId}, ${locationId}, ${input.name}, ${userId})
      RETURNING id`.execute(trx);
    await replaceSlots(trx, organizationId, r.rows[0].id, input.slots);
    return (await templatesOf(trx, organizationId, locationId)).find((t) => t.id === r.rows[0].id);
  });
}
export function updateScheduleTemplate(userId: string, organizationId: string, templateId: string, input: z.infer<typeof updateTemplateSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const t = await sql<{ location_id: string; archived_at: string | null }>`
      SELECT location_id, archived_at FROM schedule_templates WHERE id = ${templateId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx);
    if (!t.rows[0]) throw notFound();
    if (t.rows[0].archived_at && input.archived !== false) throw new ResidentialError("RESIDENTIAL_SCHEDULE_TEMPLATE_ARCHIVED", 409);
    if (input.name !== undefined) await sql`UPDATE schedule_templates SET name = ${input.name} WHERE id = ${templateId}`.execute(trx);
    if (input.archived !== undefined) await sql`UPDATE schedule_templates SET archived_at = ${input.archived ? sql`now()` : null} WHERE id = ${templateId}`.execute(trx);
    if (input.slots) await replaceSlots(trx, organizationId, templateId, input.slots);
    return (await templatesOf(trx, organizationId, t.rows[0].location_id)).find((x) => x.id === templateId);
  });
}

/**
 * Decisión de Rafa (27-nov): «Mi horario» del cuidador. Solo sus propios turnos (asignación pendiente o aceptada, con
 * membresía activa) que se cruzan con la semana, vengan del calendario publicado o de «Turnos». Los borradores no son
 * turnos, así que nunca aparecen; tampoco los de compañeros. Días y horas en la hora local (los turnos nocturnos se
 * reparten entre los dos días). Nunca la habitación técnica: el lugar es el establecimiento.
 */
type MyShiftRow = {
  id: string; starts_local: string; ends_local: string; starts_at: string; ends_at: string; status: string;
  assignment_status: string; establishment_name: string | null; room_name: string | null; resident_name: string | null;
};
export function getMyScheduleWeek(userId: string, organizationId: string, weekStart: string) {
  requireMonday(weekStart);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const worker = await sql<{ id: string }>`
      SELECT w.id FROM workers w JOIN organization_worker_memberships m ON m.worker_id = w.id
      WHERE w.user_id = ${userId} AND m.organization_id = ${organizationId} AND m.status = 'active' LIMIT 1`.execute(trx);
    if (!worker.rows[0]) throw new ResidentialError("RESIDENTIAL_SCHEDULE_STAFF_ONLY", 403);
    const r = await sql<MyShiftRow>`
      SELECT s.id,
             to_char(c.cov_start AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS starts_local,
             to_char(c.cov_end AT TIME ZONE ${TZ}, 'YYYY-MM-DD"T"HH24:MI') AS ends_local,
             c.cov_start AS starts_at, c.cov_end AS ends_at, s.status::text AS status, a.response_status::text AS assignment_status,
             COALESCE((SELECT l.name FROM establishment_technical_rooms t JOIN locations l ON l.id = t.location_id WHERE t.room_id = s.room_id),
                      (SELECT l.name FROM rooms r JOIN units u ON u.id = r.unit_id JOIN locations l ON l.id = u.location_id WHERE r.id = s.room_id),
                      (SELECT l.name FROM care_recipients c JOIN locations l ON l.id = c.location_id WHERE c.id = s.care_recipient_id)) AS establishment_name,
             CASE WHEN s.room_id IS NOT NULL AND NOT app_is_technical_room(s.room_id) THEN (SELECT r.name FROM rooms r WHERE r.id = s.room_id) END AS room_name,
             prev.display_name AS resident_name
      FROM shifts s
      JOIN assignments a ON a.shift_id = s.id AND a.response_status IN ('pending', 'accepted')
      JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id AND m.status = 'active'
      LEFT JOIN LATERAL app_my_shift_preview(s.id) prev ON true
      -- 176 (F3): tras una sustitución parcial, cada persona ve SU parte (la original hasta la hora efectiva, la sustituta
      -- desde ella), igual que en «Ponchar» y en las horas; sin sustitución, la cobertura es el turno entero.
      CROSS JOIN LATERAL app_residential_coverage_bounds(s.id, a.organization_worker_membership_id) c
      WHERE s.organization_id = ${organizationId}
        AND m.worker_id = ${worker.rows[0].id}
        AND s.status <> 'cancelled'
        AND c.cov_end > c.cov_start
        AND c.cov_start < ((${weekStart}::date + 7)::timestamp AT TIME ZONE ${TZ})
        AND c.cov_end > (${weekStart}::date::timestamp AT TIME ZONE ${TZ})
      ORDER BY c.cov_start, s.id`.execute(trx);
    const shifts = r.rows.map((x) => ({
      shiftId: x.id, startsAt: x.starts_local, endsAt: x.ends_local,
      durationMinutes: Math.round((new Date(x.ends_at).getTime() - new Date(x.starts_at).getTime()) / 60_000),
      status: x.status, assignmentStatus: x.assignment_status,
      establishmentName: x.establishment_name, roomName: x.room_name, residentName: x.resident_name,
      _start: new Date(x.starts_at), _end: new Date(x.ends_at),
    }));
    const summary = scheduleSummary(shifts.map((x) => ({ id: x.shiftId, startsAt: x._start, endsAt: x._end, membershipId: null, requiredRole: "" })));
    const byDay = new Map(summary.byDay.map((d: { date: string; minutes: number }) => [d.date, d.minutes]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const dayStart = new Date(`${date}T04:00:00Z`).getTime(), dayEnd = dayStart + 86_400_000; // 00:00 en Puerto Rico (UTC-4, sin horario de verano)
      return {
        date, minutes: byDay.get(date) ?? 0,
        shiftIds: shifts.filter((x) => x._start.getTime() < dayEnd && x._end.getTime() > dayStart).map((x) => x.shiftId),
      };
    });
    return {
      // Solo los minutos que caen dentro de la semana (un turno del domingo por la noche termina el lunes siguiente).
      weekStart, weekEnd: addDays(weekStart, 6), totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
      days, shifts: shifts.map(({ _start, _end, ...rest }) => rest),
    };
  });
}

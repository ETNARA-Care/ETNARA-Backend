import { sql, type Transaction } from "kysely";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { codeKeys, constantTimeEqual, parseQrPayload, pinCode, qrPayload, qrToken, type CodeKey, type CodeRef } from "./attendanceCodes.js";
import {
  codeStatusFor, DEFAULT_POLICY, geofenceStatus, initialValidation, orderAllowed, shiftAttendance, timeFlags,
  type EffectiveStatus, type Policy, type PunchFlag, type PunchType, type SessionState,
} from "./attendanceModel.js";
import type {
  consentSchema, correctionSchema, decideCorrectionSchema, listPunchesSchema, manualPunchSchema, policySchema, printSchema, punchSchema,
  reviewSchema, revokeSchema,
} from "./attendance.schemas.js";
import { GEO_CONSENT_VERSION } from "./attendance.schemas.js";
import { ResidentialError, RESIDENTIAL_MANAGER_REQUIRED, RESIDENTIAL_NOT_FOUND } from "./residentialErrors.js";
export { reportRange, REPORT_MAX_DAYS } from "./reportRange.js";

/**
 * 173–175 · Hogares F4: ponches con QR y código de 6 dígitos, geocerca, revisión, correcciones y alertas.
 *
 * Solo hogares (residentialGate), solo con HOGAR_PONCHES encendido (orgFeatureGate). Reglas del plan (D3, D4, §5):
 *   - todo intento se guarda con la hora del servidor; solo cuenta como validado con sesión, asignación aceptada en
 *     ese turno del establecimiento y código vigente (o en transición, solo para salir);
 *   - sin conexión nunca se valida automáticamente; nunca se impide un ponche por la ubicación;
 *   - ninguna irregularidad elimina horas ni genera deducciones; la revisión añade decisiones, no edita;
 *   - nadie revisa, decide ni poncha manualmente sobre sí mismo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trx = Transaction<any>;

export class AttendanceError extends ResidentialError {
  constructor(code: string, status: number, public readonly details?: Record<string, unknown>) { super(code, status); }
}
const unavailable = () => new AttendanceError("ATTENDANCE_UNAVAILABLE", 503);
const notFound = () => new ResidentialError(RESIDENTIAL_NOT_FOUND, 404);
export const MAX_USER_FAILED = 5;          // por persona cada 15 min
export const MAX_LOCATION_FAILED = 30;     // por establecimiento cada 15 min
export const MAX_DOWNLOADS_PER_DAY = 20;   // descargas del QR por establecimiento cada 24 h

function keys() {
  const k = codeKeys(env);
  if (!k.current) throw unavailable();
  return k as { current: CodeKey; byId: Map<string, CodeKey> };
}
async function requireManager(trx: Trx) {
  const r = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new ResidentialError(RESIDENTIAL_MANAGER_REQUIRED, 403);
}
const manage = <T>(userId: string, organizationId: string, fn: (trx: Trx) => Promise<T>) =>
  withTenantContext({ userId, organizationId }, async (trx) => { await requireManager(trx); return fn(trx); });

async function establishment(trx: Trx, organizationId: string, locationId: string) {
  const r = await sql<{ id: string; name: string; archived: boolean }>`
    SELECT l.id, l.name, l.archived_at IS NOT NULL AS archived FROM locations l
    WHERE l.id = ${locationId} AND l.organization_id = ${organizationId}
      AND EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.location_id = l.id)`.execute(trx);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
/** Lunes (fecha local de Puerto Rico) de la semana de un instante. */
export function weekOf(at: Date): string {
  const local = new Date(at.getTime() - 4 * 3_600_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const plusDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- Códigos (administración) ------------------------------------------------------------------------------------------
type CodeRow = {
  id: string; week_start: string; version: number; key_id: string; available_from: string; valid_from: string; valid_until: string;
  transition_hours: number; revoked_at: string | null; revoke_reason: string | null; created_at: string;
};
async function codesOf(trx: Trx, locationId: string, fromWeek: string) {
  const r = await sql<CodeRow>`
    SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, version, key_id, available_from, valid_from, valid_until, transition_hours,
           revoked_at, revoke_reason, created_at
    FROM attendance_codes WHERE location_id = ${locationId} AND week_start >= ${fromWeek}::date
    ORDER BY week_start DESC, version DESC`.execute(trx);
  return r.rows;
}
async function policyOf(trx: Trx, locationId: string): Promise<Policy & { version: number }> {
  const r = await sql<{ version: number; transition_hours: number; late_tolerance_minutes: number; early_leave_tolerance_minutes: number; absence_after_minutes: number }>`
    SELECT version, transition_hours, late_tolerance_minutes, early_leave_tolerance_minutes, absence_after_minutes
    FROM attendance_policies WHERE location_id = ${locationId} ORDER BY version DESC LIMIT 1`.execute(trx);
  const p = r.rows[0];
  return p ? { version: p.version, transitionHours: p.transition_hours, lateToleranceMinutes: p.late_tolerance_minutes,
    earlyLeaveToleranceMinutes: p.early_leave_tolerance_minutes, absenceAfterMinutes: p.absence_after_minutes } : { version: 0, ...DEFAULT_POLICY };
}
/** Crea, idempotente, el código de la semana actual y el de la siguiente si faltan (como el trabajo programado). */
async function ensureLocationCodes(trx: Trx, userId: string, organizationId: string, locationId: string, now: Date, keyId: string) {
  const policy = await policyOf(trx, locationId);
  for (const week of [weekOf(now), plusDays(weekOf(now), 7)]) {
    const exists = await sql`SELECT 1 FROM attendance_codes WHERE location_id = ${locationId} AND week_start = ${week}::date`.execute(trx);
    if (exists.rows.length) continue;
    const r = await sql<{ id: string }>`
      INSERT INTO attendance_codes (organization_id, location_id, week_start, version, key_id, transition_hours, available_from, valid_from, valid_until, created_by_user_id)
      VALUES (${organizationId}, ${locationId}, ${week}::date, 1, ${keyId}, ${policy.transitionHours}, now(), now(), now() + interval '1 second', ${userId})
      ON CONFLICT (location_id, week_start, version) DO NOTHING RETURNING id`.execute(trx);
    if (r.rows[0]) await sql`INSERT INTO attendance_code_events (organization_id, location_id, code_id, event_type, actor_user_id)
      VALUES (${organizationId}, ${locationId}, ${r.rows[0].id}, 'generated', ${userId})`.execute(trx);
  }
}
const presentCode = (c: CodeRow | undefined, now: Date) => c ? {
  weekStart: c.week_start, version: c.version, availableFrom: c.available_from, validFrom: c.valid_from, validUntil: c.valid_until,
  transitionHours: c.transition_hours,
  transitionUntil: new Date(new Date(c.valid_until).getTime() + c.transition_hours * 3_600_000).toISOString(),
  revokedAt: c.revoked_at, revokeReason: c.revoke_reason,
  available: new Date(c.available_from).getTime() <= now.getTime(),
} : null;

export function getAttendanceCodes(userId: string, organizationId: string, locationId: string, now = new Date()) {
  const k = keys();
  return manage(userId, organizationId, async (trx) => {
    const est = await establishment(trx, organizationId, locationId);
    if (!est.archived) await ensureLocationCodes(trx, userId, organizationId, locationId, now, k.current.keyId);
    const week = weekOf(now);
    const rows = await codesOf(trx, locationId, plusDays(week, -42));
    const latest = (w: string) => rows.find((c) => c.week_start === w);
    const prev = latest(plusDays(week, -7));
    const inTransition = prev && !prev.revoked_at && now.getTime() < new Date(prev.valid_until).getTime() + prev.transition_hours * 3_600_000;
    const events = await sql<{ event_type: string; occurred_at: string; actor_email: string | null; week_start: string; version: number; reason: string | null }>`
      SELECT e.event_type, e.occurred_at, u.email AS actor_email, to_char(c.week_start, 'YYYY-MM-DD') AS week_start, c.version, e.reason
      FROM attendance_code_events e JOIN attendance_codes c ON c.id = e.code_id LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.location_id = ${locationId} ORDER BY e.occurred_at DESC, e.id LIMIT 50`.execute(trx);
    const current = latest(week);
    return {
      establishment: { id: est.id, name: est.name },
      current: presentCode(current && !current.revoked_at ? current : undefined, now),
      next: presentCode((() => { const n = latest(plusDays(week, 7)); return n && !n.revoked_at ? n : undefined; })(), now),
      transition: inTransition ? presentCode(prev, now) : null,
      versions: rows.map((c) => presentCode(c, now)),
      events: events.rows.map((e) => ({ type: e.event_type, at: e.occurred_at, actorEmail: e.actor_email, weekStart: e.week_start, version: e.version, reason: e.reason })),
    };
  });
}

/** Imprimir o descargar: el QR y el código se derivan en el momento (nunca se guardan) y la descarga queda registrada. */
export function printAttendanceCode(userId: string, organizationId: string, locationId: string, input: z.infer<typeof printSchema>, now = new Date()) {
  const k = keys();
  return manage(userId, organizationId, async (trx) => {
    const est = await establishment(trx, organizationId, locationId);
    if (est.archived) throw new ResidentialError("RESIDENTIAL_ESTABLISHMENT_CLOSED", 409);
    if (input.weekStart !== weekOf(now) && input.weekStart !== plusDays(weekOf(now), 7)) throw new AttendanceError("ATTENDANCE_CODE_NOT_AVAILABLE", 409);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attendance-print:${locationId}`}))`.execute(trx);
    await ensureLocationCodes(trx, userId, organizationId, locationId, now, k.current.keyId);
    const c = (await sql<CodeRow>`
      SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, version, key_id, available_from, valid_from, valid_until, transition_hours, revoked_at, revoke_reason, created_at
      FROM attendance_codes WHERE location_id = ${locationId} AND week_start = ${input.weekStart}::date AND revoked_at IS NULL
      ORDER BY version DESC LIMIT 1`.execute(trx)).rows[0];
    if (!c || new Date(c.available_from).getTime() > now.getTime()) throw new AttendanceError("ATTENDANCE_CODE_NOT_AVAILABLE", 409);
    const key = k.byId.get(c.key_id);
    if (!key) throw new AttendanceError("ATTENDANCE_CODE_KEY_RETIRED", 409);
    const downloads = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM attendance_code_events WHERE location_id = ${locationId} AND event_type = 'downloaded' AND occurred_at > now() - interval '24 hours'`.execute(trx);
    if ((downloads.rows[0]?.n ?? 0) >= MAX_DOWNLOADS_PER_DAY) throw new AttendanceError("ATTENDANCE_DOWNLOAD_LIMIT", 429);
    await sql`INSERT INTO attendance_code_events (organization_id, location_id, code_id, event_type, actor_user_id)
      VALUES (${organizationId}, ${locationId}, ${c.id}, 'downloaded', ${userId})`.execute(trx);
    const ref: CodeRef = { organizationId, locationId, weekStart: c.week_start, version: c.version, keyId: c.key_id };
    return { establishment: { id: est.id, name: est.name }, code: presentCode(c, now), qr: qrPayload(key, ref), pin: pinCode(key, ref) };
  });
}

/** Revocar: inmediato, prevalece sobre la transición y crea la versión siguiente de esa semana. */
export function revokeAttendanceCode(userId: string, organizationId: string, locationId: string, input: z.infer<typeof revokeSchema>, now = new Date()) {
  const k = keys();
  return manage(userId, organizationId, async (trx) => {
    const est = await establishment(trx, organizationId, locationId);
    if (est.archived) throw new ResidentialError("RESIDENTIAL_ESTABLISHMENT_CLOSED", 409);
    if (input.weekStart !== weekOf(now) && input.weekStart !== plusDays(weekOf(now), 7)) throw new AttendanceError("ATTENDANCE_CODE_NOT_AVAILABLE", 409);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attendance-code:${locationId}:${input.weekStart}`}))`.execute(trx);
    const c = (await sql<{ id: string; version: number; transition_hours: number }>`
      SELECT id, version, transition_hours FROM attendance_codes WHERE location_id = ${locationId} AND week_start = ${input.weekStart}::date
      ORDER BY version DESC LIMIT 1 FOR UPDATE`.execute(trx)).rows[0];
    if (!c) throw new AttendanceError("ATTENDANCE_CODE_NOT_AVAILABLE", 409);
    await sql`UPDATE attendance_codes SET revoked_at = now(), revoked_by_user_id = ${userId}, revoke_reason = ${input.reason}
      WHERE id = ${c.id} AND revoked_at IS NULL`.execute(trx);
    await sql`INSERT INTO attendance_code_events (organization_id, location_id, code_id, event_type, actor_user_id, reason)
      VALUES (${organizationId}, ${locationId}, ${c.id}, 'revoked', ${userId}, ${input.reason})`.execute(trx);
    const n = await sql<{ id: string }>`
      INSERT INTO attendance_codes (organization_id, location_id, week_start, version, key_id, transition_hours, available_from, valid_from, valid_until, created_by_user_id)
      VALUES (${organizationId}, ${locationId}, ${input.weekStart}::date, ${c.version + 1}, ${k.current.keyId}, ${c.transition_hours}, now(), now(), now() + interval '1 second', ${userId})
      RETURNING id`.execute(trx);
    await sql`INSERT INTO attendance_code_events (organization_id, location_id, code_id, event_type, actor_user_id)
      VALUES (${organizationId}, ${locationId}, ${n.rows[0].id}, 'generated', ${userId})`.execute(trx);
    return { weekStart: input.weekStart, revokedVersion: c.version, newVersion: c.version + 1 };
  });
}

// ---- Política ------------------------------------------------------------------------------------------------------
export function getAttendancePolicy(userId: string, organizationId: string, locationId: string) {
  return manage(userId, organizationId, async (trx) => {
    await establishment(trx, organizationId, locationId);
    return policyOf(trx, locationId);
  });
}
export function updateAttendancePolicy(userId: string, organizationId: string, locationId: string, input: z.infer<typeof policySchema>) {
  return manage(userId, organizationId, async (trx) => {
    await establishment(trx, organizationId, locationId);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attendance-policy:${locationId}`}))`.execute(trx);
    const current = await policyOf(trx, locationId);
    await sql`INSERT INTO attendance_policies (organization_id, location_id, version, transition_hours, late_tolerance_minutes, early_leave_tolerance_minutes,
                absence_after_minutes, reason, created_by_user_id)
      VALUES (${organizationId}, ${locationId}, ${current.version + 1}, ${input.transitionHours}, ${input.lateToleranceMinutes}, ${input.earlyLeaveToleranceMinutes},
              ${input.absenceAfterMinutes}, ${input.reason}, ${userId})`.execute(trx);
    // La nueva transición se aplica a los códigos que siguen en uso (la base rechaza tocar los ya vencidos).
    await sql`UPDATE attendance_codes SET transition_hours = ${input.transitionHours}
      WHERE location_id = ${locationId} AND valid_until + make_interval(hours => transition_hours) > now()`.execute(trx);
    return policyOf(trx, locationId);
  });
}

// ---- Ponchar (personal) ------------------------------------------------------------------------------------------------
type MyShift = {
  shift_id: string; location_id: string; location_name: string; membership_id: string; scheduled_start: string; scheduled_end: string;
  shift_status: string; geofence_latitude: string | null; geofence_longitude: string | null; geofence_radius_m: number;
};
type PunchRow = {
  id: string; shift_id: string; location_id: string; punch_type: PunchType; origin: string; declared_at: string | null; server_received_at: string;
  effective_at: string; code_method: string; code_status: string; code_id: string | null; location_status: string; distance_m: number | null;
  accuracy_m: number | null; initial_validation: string; flags: string[]; session_in_punch_id: string | null; manual_reason: string | null;
  user_id: string; organization_worker_membership_id: string;
};
const PUNCH_COLS = sql`p.id, p.shift_id, p.location_id, p.punch_type, p.origin, p.declared_at, p.server_received_at, p.effective_at, p.code_method,
  p.code_status, p.code_id, p.location_status, p.distance_m, p.accuracy_m, p.initial_validation, p.flags, p.session_in_punch_id, p.manual_reason,
  p.user_id, p.organization_worker_membership_id`;
const EFFECTIVE = sql`COALESCE((SELECT r.decision FROM attendance_reviews r WHERE r.punch_id = p.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1), p.initial_validation)`;
const presentPunch = (p: PunchRow & { effective_status?: string; worker_name?: string | null; location_name?: string | null }) => ({
  id: p.id, shiftId: p.shift_id, locationId: p.location_id, type: p.punch_type, origin: p.origin, declaredAt: p.declared_at,
  serverReceivedAt: p.server_received_at, effectiveAt: p.effective_at, code: { method: p.code_method, status: p.code_status },
  location: { status: p.location_status, distanceM: p.distance_m, accuracyM: p.accuracy_m },
  validation: { initial: p.initial_validation, effective: (p.effective_status ?? p.initial_validation) as EffectiveStatus },
  flags: p.flags, manualReason: p.manual_reason, membershipId: p.organization_worker_membership_id,
  ...(p.worker_name !== undefined ? { workerName: p.worker_name } : {}), ...(p.location_name !== undefined ? { locationName: p.location_name } : {}),
});

async function myShift(trx: Trx, shiftId: string): Promise<MyShift | null> {
  const r = await sql<MyShift>`SELECT * FROM app_attendance_my_shifts(now(), now(), ${shiftId}::uuid)`.execute(trx);
  return r.rows[0] ?? null;
}
async function sessionState(trx: Trx, userId: string, shiftId: string): Promise<SessionState & { openIn: PunchRow | null }> {
  const r = await sql<PunchRow>`SELECT ${PUNCH_COLS} FROM attendance_punches p WHERE p.user_id = ${userId} AND p.shift_id = ${shiftId}
    ORDER BY p.effective_at, p.server_received_at, p.id`.execute(trx);
  let openIn: PunchRow | null = null, breakOpen = false, mealOpen = false;
  for (const p of r.rows) {
    if (p.punch_type === "in") { if (!openIn) { openIn = p; breakOpen = false; mealOpen = false; } }
    else if (p.punch_type === "out") { if (openIn && (p.session_in_punch_id === openIn.id || p.origin === "manual")) { openIn = null; breakOpen = false; mealOpen = false; } }
    else if (openIn && (p.session_in_punch_id === openIn.id || p.origin === "manual")) {
      if (p.punch_type === "break_start") breakOpen = true; if (p.punch_type === "break_end") breakOpen = false;
      if (p.punch_type === "meal_start") mealOpen = true; if (p.punch_type === "meal_end") mealOpen = false;
    }
  }
  return { openIn, openInId: openIn?.id ?? null, openInCodeId: openIn?.code_id ?? null, breakOpen, mealOpen };
}

type CodeWindowRow = { code_id: string; week_start: string; version: number; key_id: string; role: "current" | "transition"; valid_from: string; valid_until: string; transition_until: string };
type CodeEval = { match: "current" | "transition" | null; codeId: string | null; transitionCodeId: string | null; validFrom: Date | null;
  outcome: "current" | "transition" | "invalid" | "expired" | "revoked" | "other_location" };
async function evaluateCode(trx: Trx, organizationId: string, locationId: string, at: Date, input: { method: "qr" | "pin"; qr?: string; pin?: string }): Promise<CodeEval> {
  const k = keys();
  const win = (await sql<CodeWindowRow>`SELECT code_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, version, key_id, role, valid_from, valid_until, transition_until
    FROM app_attendance_code_window(${locationId}::uuid, ${at.toISOString()}::timestamptz)`.execute(trx)).rows;
  const transitionCodeId = win.find((w) => w.role === "transition")?.code_id ?? null;
  const ref = (w: { week_start: string; version: number; key_id: string }): CodeRef => ({ organizationId, locationId, weekStart: w.week_start, version: w.version, keyId: w.key_id });
  const result = (w: CodeWindowRow): CodeEval => ({ match: w.role, codeId: w.code_id, transitionCodeId, validFrom: new Date(w.valid_from), outcome: w.role });
  if (input.method === "pin") {
    let hit: CodeWindowRow | null = null;
    for (const w of win) { const key = k.byId.get(w.key_id); if (key && constantTimeEqual(pinCode(key, ref(w)), input.pin ?? "")) hit = hit ?? w; }
    return hit ? result(hit) : { match: null, codeId: null, transitionCodeId, validFrom: null, outcome: "invalid" };
  }
  const q = parseQrPayload(input.qr);
  if (!q) return { match: null, codeId: null, transitionCodeId, validFrom: null, outcome: "invalid" };
  if (q.locationId !== locationId.toLowerCase()) return { match: null, codeId: null, transitionCodeId, validFrom: null, outcome: "other_location" };
  const key = k.byId.get(q.keyId);
  const authentic = !!key && constantTimeEqual(qrToken(key, { organizationId, locationId, weekStart: q.weekStart, version: q.version, keyId: q.keyId }), q.token);
  if (!authentic) return { match: null, codeId: null, transitionCodeId, validFrom: null, outcome: "invalid" };
  const w = win.find((x) => x.week_start === q.weekStart && x.version === q.version && x.key_id === q.keyId);
  if (w) return result(w);
  // Auténtico pero no vigente: de la semana actual con otra versión → revocado; si no → vencido.
  const current = win.find((x) => x.role === "current");
  return { match: null, codeId: null, transitionCodeId, validFrom: null, outcome: current && current.week_start === q.weekStart ? "revoked" : "expired" };
}

export type PunchResult = { blocked: true } | { blocked: false; duplicate: boolean; punch: ReturnType<typeof presentPunch> };

/**
 * 27-nov (auditoría GPT, B): un client_event_id ya usado solo es «el mismo ponche» si es del mismo turno y del mismo tipo.
 * Si llega con otro turno u otro tipo, es un conflicto del cliente (409): nunca se devuelve el ponche anterior como si
 * fuera el nuevo.
 */
function sameEventOrConflict(prior: PunchRow & { effective_status: string }, input: { shiftId: string; type: string }) {
  if (prior.shift_id !== input.shiftId || prior.punch_type !== input.type) throw new AttendanceError("ATTENDANCE_DUPLICATE_EVENT", 409);
  return { blocked: false as const, duplicate: true, punch: presentPunch(prior) };
}

export function punch(userId: string, organizationId: string, input: z.infer<typeof punchSchema>, now = new Date()): Promise<PunchResult> {
  keys();
  return withTenantContext({ userId, organizationId }, async (trx): Promise<PunchResult> => {
    // Idempotencia: el mismo client_event_id devuelve el ponche ya registrado.
    const prior = await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p
      WHERE p.organization_id = ${organizationId} AND p.user_id = ${userId} AND p.client_event_id = ${input.clientEventId}`.execute(trx);
    if (prior.rows[0]) return sameEventOrConflict(prior.rows[0], input);
    const shift = await myShift(trx, input.shiftId);
    if (!shift || shift.shift_status === "cancelled") throw new AttendanceError("ATTENDANCE_NOT_AUTHORIZED", 403);

    // 27-nov (auditoría GPT, C): los intentos de un establecimiento se cuentan y registran de uno en uno (bloqueo hasta el
    // final de la transacción). Antes, varios intentos incorrectos simultáneos leían el mismo recuento y rebasaban el
    // límite (comprobado: 12 de 12 a la vez para una persona). Se toma ANTES del bloqueo por persona y turno (orden fijo).
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attendance-attempts:${shift.location_id}`}))`.execute(trx);
    const failed = (await sql<{ user_failed: number; location_failed: number }>`SELECT * FROM app_attendance_failed_attempts(${shift.location_id}::uuid)`.execute(trx)).rows[0];
    if (!failed || failed.user_failed >= MAX_USER_FAILED || failed.location_failed >= MAX_LOCATION_FAILED) {
      await sql`INSERT INTO attendance_code_attempts (organization_id, location_id, user_id, method, outcome)
        VALUES (${organizationId}, ${shift.location_id}, ${userId}, ${input.method}, 'blocked')`.execute(trx);
      await sql`SELECT app_attendance_record_blocked_attempt(${shift.location_id}::uuid)`.execute(trx);
      return { blocked: true };
    }

    await sql`SELECT pg_advisory_xact_lock(hashtext(${`attendance-punch:${userId}:${input.shiftId}`}))`.execute(trx);
    // 27-nov: se repite la comprobación de idempotencia ya con el bloqueo. Si el teléfono envió el mismo ponche dos veces
    // a la vez (cola sin conexión + reintento), el segundo envío espera al primero y devuelve el ponche ya registrado
    // en lugar de chocar con el índice único (antes, un 500 en salidas y descansos).
    const priorLocked = await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p
      WHERE p.organization_id = ${organizationId} AND p.user_id = ${userId} AND p.client_event_id = ${input.clientEventId}`.execute(trx);
    if (priorLocked.rows[0]) return sameEventOrConflict(priorLocked.rows[0], input);
    const offline = input.offline;
    const effectiveAt = offline ? new Date(input.declaredAt!) : now;
    const code = await evaluateCode(trx, organizationId, shift.location_id, effectiveAt, input);
    await sql`INSERT INTO attendance_code_attempts (organization_id, location_id, user_id, method, outcome)
      VALUES (${organizationId}, ${shift.location_id}, ${userId}, ${input.method}, ${code.outcome})`.execute(trx);

    const session = await sessionState(trx, userId, input.shiftId);
    // Segunda entrada con una sesión abierta: la máquina de estados devuelve la que ya existe.
    if (input.type === "in" && session.openIn) {
      const existing = await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p WHERE p.id = ${session.openIn.id}`.execute(trx);
      return { blocked: false, duplicate: true, punch: presentPunch(existing.rows[0]) };
    }
    const flags = new Set<PunchFlag>();
    const cs = codeStatusFor({ match: code.match, type: input.type, transitionCodeId: code.transitionCodeId, session });
    cs.flags.forEach((f) => flags.add(f));
    if (!orderAllowed(input.type, session)) flags.add("impossible_order");

    const consent = (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM attendance_geo_consents WHERE organization_id = ${organizationId}
      AND user_id = ${userId} AND revoked_at IS NULL AND consent_version = ${GEO_CONSENT_VERSION}) AS ok`.execute(trx)).rows[0].ok;
    const center = shift.geofence_latitude !== null && shift.geofence_longitude !== null ? { lat: Number(shift.geofence_latitude), lng: Number(shift.geofence_longitude) } : null;
    // Sin conexión no se usa la ubicación (y nunca se guarda en el teléfono): queda «no disponible».
    const geo = geofenceStatus({
      consent, center, radiusM: shift.geofence_radius_m,
      reading: !offline && input.location ? { lat: input.location.latitude, lng: input.location.longitude, accuracy: input.location.accuracy } : null,
    });
    geo.flags.forEach((f) => flags.add(f));
    timeFlags({
      offline, effectiveAt, serverNow: now, deviceNow: input.deviceNow ? new Date(input.deviceNow) : null, type: input.type,
      shiftStart: new Date(shift.scheduled_start), shiftEnd: new Date(shift.scheduled_end), codeValidFrom: code.validFrom,
    }).forEach((f) => flags.add(f));
    const flagList = [...flags];
    const validation = initialValidation({ offline, codeStatus: cs.status, location: geo.status, flags: flagList });
    const sessionIn = input.type === "in" || flags.has("impossible_order") ? null : session.openInId;
    const inserted = await sql<{ id: string }>`
      INSERT INTO attendance_punches (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_type, client_event_id,
        origin, declared_at, effective_at, code_method, code_status, code_id, location_status, distance_m, accuracy_m, initial_validation, flags,
        session_in_punch_id, created_by_user_id)
      VALUES (${organizationId}, ${shift.location_id}, ${input.shiftId}, ${shift.membership_id}, ${userId}, ${input.type}, ${input.clientEventId},
        ${offline ? "offline" : "online"}, ${input.declaredAt ?? null}, ${effectiveAt.toISOString()}, ${input.method}, ${cs.status},
        ${cs.status === "current" || cs.status === "transition" ? code.codeId : null}, ${geo.status}, ${geo.distanceM}, ${geo.accuracyM},
        ${validation}, ${sql`${flagList}::text[]`}, ${sessionIn}, ${userId})
      RETURNING id`.execute(trx);
    await sql`SELECT app_attendance_record_punch_alerts(${inserted.rows[0].id}::uuid)`.execute(trx);
    const row = await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p WHERE p.id = ${inserted.rows[0].id}`.execute(trx);
    return { blocked: false, duplicate: false, punch: presentPunch(row.rows[0]) };
  });
}

/** Pantalla «Ponchar»: turnos propios de ahora (12 h atrás a 24 h adelante), sesión abierta y consentimiento. */
export function myAttendance(userId: string, organizationId: string, now = new Date()) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const shifts = (await sql<MyShift>`SELECT * FROM app_attendance_my_shifts(${new Date(now.getTime() - 12 * 3_600_000).toISOString()}::timestamptz,
      ${new Date(now.getTime() + 24 * 3_600_000).toISOString()}::timestamptz, NULL)`.execute(trx)).rows;
    const out = [];
    for (const s of shifts) {
      const st = await sessionState(trx, userId, s.shift_id);
      out.push({ shiftId: s.shift_id, establishment: { id: s.location_id, name: s.location_name }, scheduledStart: s.scheduled_start,
        scheduledEnd: s.scheduled_end, openSession: st.openInId !== null, breakOpen: st.breakOpen, mealOpen: st.mealOpen });
    }
    const consent = (await sql<{ consent_version: string; accepted_at: string }>`SELECT consent_version, accepted_at FROM attendance_geo_consents
      WHERE organization_id = ${organizationId} AND user_id = ${userId} AND revoked_at IS NULL`.execute(trx)).rows[0];
    const recent = (await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p
      WHERE p.organization_id = ${organizationId} AND p.user_id = ${userId} AND p.effective_at > now() - interval '14 days'
      ORDER BY p.effective_at DESC, p.id LIMIT 50`.execute(trx)).rows;
    return {
      shifts: out,
      consent: { currentVersion: GEO_CONSENT_VERSION, accepted: consent?.consent_version === GEO_CONSENT_VERSION, acceptedAt: consent?.accepted_at ?? null },
      recentPunches: recent.map(presentPunch),
    };
  });
}

export function setGeoConsent(userId: string, organizationId: string, input: z.infer<typeof consentSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await sql`UPDATE attendance_geo_consents SET revoked_at = now() WHERE organization_id = ${organizationId} AND user_id = ${userId} AND revoked_at IS NULL`.execute(trx);
    if (input.accept) {
      await sql`INSERT INTO attendance_geo_consents (organization_id, user_id, consent_version) VALUES (${organizationId}, ${userId}, ${input.version})`.execute(trx);
    }
    return { currentVersion: GEO_CONSENT_VERSION, accepted: input.accept };
  });
}

export function requestCorrection(userId: string, organizationId: string, input: z.infer<typeof correctionSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const shift = await myShift(trx, input.shiftId);
    if (!shift) throw new AttendanceError("ATTENDANCE_NOT_AUTHORIZED", 403);
    const r = await sql<{ id: string }>`
      INSERT INTO attendance_correction_requests (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_id,
        requested_type, requested_at, reason)
      VALUES (${organizationId}, ${shift.location_id}, ${input.shiftId}, ${shift.membership_id}, ${userId}, ${input.punchId ?? null},
        ${input.type}, ${input.requestedAt}, ${input.reason})
      RETURNING id`.execute(trx);
    return { id: r.rows[0].id, status: "pending" };
  });
}

export function myCorrections(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await sql<{ id: string; shift_id: string; punch_id: string | null; requested_type: string; requested_at: string; reason: string; status: string;
      decision_reason: string | null; decided_at: string | null; created_at: string }>`
      SELECT id, shift_id, punch_id, requested_type, requested_at, reason, status, decision_reason, decided_at, created_at
      FROM attendance_correction_requests WHERE organization_id = ${organizationId} AND user_id = ${userId}
      ORDER BY created_at DESC LIMIT 50`.execute(trx);
    return r.rows.map((c) => ({ id: c.id, shiftId: c.shift_id, punchId: c.punch_id, type: c.requested_type, requestedAt: c.requested_at, reason: c.reason,
      status: c.status, decisionReason: c.decision_reason, decidedAt: c.decided_at, createdAt: c.created_at }));
  });
}

// ---- Revisión (administración) -------------------------------------------------------------------------------------------
export function listPunches(userId: string, organizationId: string, input: z.infer<typeof listPunchesSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const from = input.from ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
    const to = input.to ?? new Date(Date.now() + 86_400_000).toISOString();
    const r = await sql<PunchRow & { effective_status: string; worker_name: string | null; location_name: string }>`
      SELECT * FROM (
        SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status, w.display_name AS worker_name, l.name AS location_name
        FROM attendance_punches p
        JOIN organization_worker_memberships m ON m.id = p.organization_worker_membership_id
        JOIN workers w ON w.id = m.worker_id
        JOIN locations l ON l.id = p.location_id
        WHERE p.organization_id = ${organizationId} AND p.effective_at >= ${from}::timestamptz AND p.effective_at < ${to}::timestamptz
          ${input.locationId ? sql`AND p.location_id = ${input.locationId}` : sql``}
      ) x ${input.status ? sql`WHERE x.effective_status = ${input.status}` : sql``}
      ORDER BY x.effective_at DESC, x.id LIMIT 500`.execute(trx);
    const pending = await sql<{ n: number }>`SELECT count(*)::int AS n FROM attendance_punches p WHERE p.organization_id = ${organizationId} AND ${EFFECTIVE} = 'pending_review'`.execute(trx);
    return { punches: r.rows.map(presentPunch), pendingTotal: pending.rows[0]?.n ?? 0 };
  });
}

export function punchHistory(userId: string, organizationId: string, punchId: string) {
  return manage(userId, organizationId, async (trx) => {
    const p = await sql<PunchRow & { effective_status: string }>`SELECT ${PUNCH_COLS}, ${EFFECTIVE} AS effective_status FROM attendance_punches p
      WHERE p.id = ${punchId} AND p.organization_id = ${organizationId}`.execute(trx);
    if (!p.rows[0]) throw notFound();
    const reviews = await sql<{ decision: string; reason: string; reviewed_at: string; reviewer_email: string | null; batch_id: string | null }>`
      SELECT r.decision, r.reason, r.reviewed_at, u.email AS reviewer_email, r.batch_id FROM attendance_reviews r LEFT JOIN users u ON u.id = r.reviewer_user_id
      WHERE r.punch_id = ${punchId} ORDER BY r.reviewed_at, r.id`.execute(trx);
    return { punch: presentPunch(p.rows[0]), reviews: reviews.rows.map((r) => ({ decision: r.decision, reason: r.reason, at: r.reviewed_at, reviewerEmail: r.reviewer_email, batchId: r.batch_id })) };
  });
}

/** Una por una o en bloque, siempre con motivo; el original no cambia. Nunca sobre ponches propios. */
export function reviewPunches(userId: string, organizationId: string, input: z.infer<typeof reviewSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const ids = [...new Set(input.punchIds)];
    const found = await sql<{ id: string; user_id: string }>`SELECT id, user_id FROM attendance_punches WHERE organization_id = ${organizationId} AND id = ANY(${ids}::uuid[])`.execute(trx);
    if (found.rows.length !== ids.length) throw notFound();
    if (found.rows.some((p) => p.user_id === userId)) throw new AttendanceError("ATTENDANCE_SELF_REVIEW", 403);
    const batch = ids.length > 1 ? (await sql<{ id: string }>`SELECT gen_random_uuid() AS id`.execute(trx)).rows[0].id : null;
    for (const id of ids) {
      await sql`INSERT INTO attendance_reviews (organization_id, punch_id, decision, reason, batch_id, reviewer_user_id)
        VALUES (${organizationId}, ${id}, ${input.decision}, ${input.reason}, ${batch}, ${userId})`.execute(trx);
    }
    return { reviewed: ids.length, decision: input.decision, batchId: batch };
  });
}

async function insertManual(trx: Trx, userId: string, organizationId: string, p: { shiftId: string; membershipId: string; type: PunchType; at: string; reason: string }) {
  const s = await sql<{ location_id: string; worker_user: string }>`
    SELECT t.location_id, w.user_id AS worker_user FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id
    JOIN organization_worker_memberships m ON m.id = ${p.membershipId} AND m.organization_id = s.organization_id
    JOIN workers w ON w.id = m.worker_id
    WHERE s.id = ${p.shiftId} AND s.organization_id = ${organizationId}`.execute(trx);
  if (!s.rows[0]) throw notFound();
  if (s.rows[0].worker_user === userId) throw new AttendanceError("ATTENDANCE_SELF_REVIEW", 403);
  const r = await sql<{ id: string }>`
    INSERT INTO attendance_punches (organization_id, location_id, shift_id, organization_worker_membership_id, user_id, punch_type, origin, declared_at,
      effective_at, code_method, code_status, location_status, initial_validation, manual_reason, created_by_user_id)
    VALUES (${organizationId}, ${s.rows[0].location_id}, ${p.shiftId}, ${p.membershipId}, ${s.rows[0].worker_user}, ${p.type}, 'manual', ${p.at},
      ${p.at}, 'none', 'none', 'unavailable', 'justified', ${p.reason}, ${userId})
    RETURNING id`.execute(trx);
  return r.rows[0].id;
}
/** Ponche manual de la administración (contingencia), con motivo: queda «justificado» y en el historial. */
export function manualPunch(userId: string, organizationId: string, input: z.infer<typeof manualPunchSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const id = await insertManual(trx, userId, organizationId, input);
    return { id };
  });
}

export function listCorrections(userId: string, organizationId: string, status: "pending" | "all") {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string; shift_id: string; punch_id: string | null; requested_type: string; requested_at: string; reason: string; status: string;
      decision_reason: string | null; decided_at: string | null; created_at: string; worker_name: string | null; location_name: string; membership_id: string }>`
      SELECT c.id, c.shift_id, c.punch_id, c.requested_type, c.requested_at, c.reason, c.status, c.decision_reason, c.decided_at, c.created_at,
             w.display_name AS worker_name, l.name AS location_name, c.organization_worker_membership_id AS membership_id
      FROM attendance_correction_requests c JOIN organization_worker_memberships m ON m.id = c.organization_worker_membership_id
      JOIN workers w ON w.id = m.worker_id JOIN locations l ON l.id = c.location_id
      WHERE c.organization_id = ${organizationId} ${status === "pending" ? sql`AND c.status = 'pending'` : sql``}
      ORDER BY c.created_at DESC LIMIT 200`.execute(trx);
    return r.rows.map((c) => ({ id: c.id, shiftId: c.shift_id, punchId: c.punch_id, type: c.requested_type, requestedAt: c.requested_at, reason: c.reason,
      status: c.status, decisionReason: c.decision_reason, decidedAt: c.decided_at, createdAt: c.created_at, workerName: c.worker_name,
      locationName: c.location_name, membershipId: c.membership_id }));
  });
}

/** Aprobar crea un ponche manual justificado; si corregía un ponche, el original queda «no reconocido» (se conserva). */
export function decideCorrection(userId: string, organizationId: string, correctionId: string, input: z.infer<typeof decideCorrectionSchema>) {
  return manage(userId, organizationId, async (trx) => {
    const c = (await sql<{ id: string; status: string; user_id: string; shift_id: string; membership_id: string; punch_id: string | null; requested_type: PunchType; requested_at: string }>`
      SELECT id, status, user_id, shift_id, organization_worker_membership_id AS membership_id, punch_id, requested_type, requested_at
      FROM attendance_correction_requests WHERE id = ${correctionId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
    if (!c) throw notFound();
    if (c.status !== "pending") throw new AttendanceError("ATTENDANCE_ALREADY_DECIDED", 409);
    if (c.user_id === userId) throw new AttendanceError("ATTENDANCE_SELF_REVIEW", 403);
    let resulting: string | null = null;
    if (input.approve) {
      resulting = await insertManual(trx, userId, organizationId, { shiftId: c.shift_id, membershipId: c.membership_id, type: c.requested_type,
        at: new Date(c.requested_at).toISOString(), reason: `Corrección aprobada: ${input.reason}`.slice(0, 300) });
      if (c.punch_id) {
        await sql`INSERT INTO attendance_reviews (organization_id, punch_id, decision, reason, reviewer_user_id)
          VALUES (${organizationId}, ${c.punch_id}, 'not_recognized', ${`Sustituido por una corrección aprobada: ${input.reason}`.slice(0, 300)}, ${userId})`.execute(trx);
      }
    }
    await sql`UPDATE attendance_correction_requests SET status = ${input.approve ? "approved" : "rejected"}, decided_by_user_id = ${userId},
      decision_reason = ${input.reason}, resulting_punch_id = ${resulting} WHERE id = ${correctionId}`.execute(trx);
    return { id: correctionId, status: input.approve ? "approved" : "rejected", resultingPunchId: resulting };
  });
}

export function listAlerts(userId: string, organizationId: string, open: boolean) {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string; kind: string; location_name: string; worker_name: string | null; punch_id: string | null; created_at: string; acknowledged_at: string | null }>`
      SELECT a.id, a.kind, l.name AS location_name, w.display_name AS worker_name, a.punch_id, a.created_at, a.acknowledged_at
      FROM attendance_alerts a JOIN locations l ON l.id = a.location_id
      LEFT JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id LEFT JOIN workers w ON w.id = m.worker_id
      WHERE a.organization_id = ${organizationId} ${open ? sql`AND a.acknowledged_at IS NULL` : sql``}
      ORDER BY a.created_at DESC LIMIT 200`.execute(trx);
    return r.rows.map((a) => ({ id: a.id, kind: a.kind, locationName: a.location_name, workerName: a.worker_name, punchId: a.punch_id, createdAt: a.created_at, acknowledgedAt: a.acknowledged_at }));
  });
}
export function acknowledgeAlert(userId: string, organizationId: string, alertId: string) {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string }>`UPDATE attendance_alerts SET acknowledged_at = now(), acknowledged_by_user_id = ${userId}
      WHERE id = ${alertId} AND organization_id = ${organizationId} AND acknowledged_at IS NULL RETURNING id`.execute(trx);
    if (!r.rows[0]) throw notFound();
    return { id: alertId, acknowledged: true };
  });
}

/** Asistencia de la semana por turno y persona: tardanzas, salidas anticipadas y ausencias como datos administrativos. */
/**
 * Filas de asistencia de un establecimiento entre dos días locales (Puerto Rico), por turno y persona aceptada.
 * 176 (F3): cada persona con su parte del turno (cobertura) cuando hubo una sustitución; las horas salen solo de los
 * ponches y se recortan en el límite de la sustitución, así que nunca se duplican.
 */
async function attendanceRows(trx: Trx, organizationId: string, locationId: string, fromDate: string, days: number, policy: Policy, now: Date) {
  const rows = (await sql<{ shift_id: string; scheduled_start: string; scheduled_end: string; membership_id: string; worker_name: string | null; shift_status: string;
    cov_start: string; cov_end: string }>`
    SELECT s.id AS shift_id, s.scheduled_start, s.scheduled_end, a.organization_worker_membership_id AS membership_id, w.display_name AS worker_name, s.status::text AS shift_status,
           c.cov_start, c.cov_end
    FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id AND t.location_id = ${locationId}
    JOIN assignments a ON a.shift_id = s.id AND a.response_status = 'accepted'
    CROSS JOIN LATERAL app_residential_coverage_bounds(s.id, a.organization_worker_membership_id) c
    JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id JOIN workers w ON w.id = m.worker_id
    WHERE s.organization_id = ${organizationId} AND s.status::text <> 'cancelled'
      AND s.scheduled_start >= (${fromDate}::date::timestamp AT TIME ZONE 'America/Puerto_Rico')
      AND s.scheduled_start < ((${fromDate}::date + ${days}::int)::timestamp AT TIME ZONE 'America/Puerto_Rico')
    ORDER BY s.scheduled_start, w.display_name, a.organization_worker_membership_id`.execute(trx)).rows;
  const out = [];
  for (const r of rows) {
    const ps = (await sql<{ id: string; punch_type: PunchType; effective_at: string; effective_status: EffectiveStatus; session_in_punch_id: string | null }>`
      SELECT p.id, p.punch_type, p.effective_at, ${EFFECTIVE} AS effective_status, p.session_in_punch_id FROM attendance_punches p
      WHERE p.shift_id = ${r.shift_id} AND p.organization_worker_membership_id = ${r.membership_id}`.execute(trx)).rows;
    const clipFrom = r.cov_start !== r.scheduled_start && new Date(r.cov_start).getTime() !== new Date(r.scheduled_start).getTime() ? new Date(r.cov_start) : null;
    const clipTo = new Date(r.cov_end).getTime() !== new Date(r.scheduled_end).getTime() ? new Date(r.cov_end) : null;
    const a = shiftAttendance({ start: new Date(r.cov_start), end: new Date(r.cov_end), now, policy, clip: { from: clipFrom, to: clipTo },
      punches: ps.map((p) => ({ id: p.id, type: p.punch_type, at: new Date(p.effective_at), status: p.effective_status, sessionInId: p.session_in_punch_id })) });
    out.push({ shiftId: r.shift_id, scheduledStart: r.cov_start, scheduledEnd: r.cov_end, membershipId: r.membership_id, workerName: r.worker_name,
      substitutedPart: clipFrom !== null || clipTo !== null, ...a });
  }
  return out;
}

export function weekAttendance(userId: string, organizationId: string, locationId: string, weekStart: string, now = new Date()) {
  return manage(userId, organizationId, async (trx) => {
    const est = await establishment(trx, organizationId, locationId);
    const policy = await policyOf(trx, locationId);
    return { establishment: { id: est.id, name: est.name }, weekStart, policy, rows: await attendanceRows(trx, organizationId, locationId, weekStart, 7, policy, now) };
  });
}

/**
 * 177 (F5): informe de asistencia y horas trabajadas de un establecimiento en un rango. Validadas y pendientes siempre
 * por separado; tardanzas, salidas anticipadas y ausencias como datos administrativos. No es nómina.
 */
export async function attendanceReportIn(trx: Trx, organizationId: string, locationId: string, range: { from: string; to: string; days: number }, now = new Date()) {
  {
    const est = await establishment(trx, organizationId, locationId);
    const policy = await policyOf(trx, locationId);
    const rows = await attendanceRows(trx, organizationId, locationId, range.from, range.days, policy, now);
    const blank = () => ({ shifts: 0, validatedMinutes: 0, pendingMinutes: 0, breakMinutes: 0, mealMinutes: 0, lateCount: 0, lateMinutes: 0,
      earlyLeaveCount: 0, earlyLeaveMinutes: 0, absences: 0, openSessions: 0 });
    type Tot = ReturnType<typeof blank>;
    const add = (t: Tot, r: (typeof rows)[number]) => {
      t.shifts += 1; t.validatedMinutes += r.validatedMinutes; t.pendingMinutes += r.pendingMinutes; t.breakMinutes += r.breakMinutes; t.mealMinutes += r.mealMinutes;
      if (r.lateMinutes > 0) { t.lateCount += 1; t.lateMinutes += r.lateMinutes; }
      if (r.earlyLeaveMinutes > 0) { t.earlyLeaveCount += 1; t.earlyLeaveMinutes += r.earlyLeaveMinutes; }
      if (r.absent) t.absences += 1;
      if (r.openSession) t.openSessions += 1;
    };
    const people = new Map<string, { membershipId: string; workerName: string | null } & Tot>();
    const totals = blank();
    for (const r of rows) {
      const p = people.get(r.membershipId) ?? { membershipId: r.membershipId, workerName: r.workerName, ...blank() };
      add(p, r); add(totals, r); people.set(r.membershipId, p);
    }
    return { establishment: { id: est.id, name: est.name }, from: range.from, to: range.to, days: range.days, policy, rows,
      people: [...people.values()].sort((a, b) => (a.workerName ?? "").localeCompare(b.workerName ?? "", "es") || a.membershipId.localeCompare(b.membershipId)), totals };
  }
}

/** Establecimientos de hogar abiertos (para las pantallas de la administración). */
export function attendanceEstablishments(userId: string, organizationId: string) {
  return manage(userId, organizationId, async (trx) => {
    const r = await sql<{ id: string; name: string }>`SELECT l.id, l.name FROM locations l WHERE l.organization_id = ${organizationId} AND l.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM establishment_technical_rooms t WHERE t.location_id = l.id) ORDER BY l.name, l.id`.execute(trx);
    return r.rows;
  });
}

/**
 * 177 (F5): parte de asistencia del panel del hogar (solo administración; el llamador ya comprobó el rol y el interruptor).
 * Presentes: sesiones abiertas ahora con la entrada CONFIRMADA (validada o justificada; una entrada pendiente de revisión
 * no es presencia confirmada y solo cuenta en «por revisar»), en un turno no cancelado y de las últimas 24 h. La sesión
 * se cierra con la misma regla que el cálculo de horas (attendanceModel): una salida de esa sesión (o sin sesión y
 * posterior) que no esté marcada como no reconocida. Solo nombre del personal y establecimiento: sin ubicación ni datos
 * del ponche.
 */
export async function attendancePanelSection(trx: Trx, organizationId: string, now = new Date()) {
  const present = (await sql<{ worker_name: string | null; location_name: string; since: string }>`
    SELECT DISTINCT ON (p.organization_worker_membership_id) w.display_name AS worker_name, l.name AS location_name, p.effective_at AS since
    FROM attendance_punches p
    JOIN shifts s ON s.id = p.shift_id AND s.status::text <> 'cancelled'
    JOIN organization_worker_memberships m ON m.id = p.organization_worker_membership_id
    JOIN workers w ON w.id = m.worker_id JOIN locations l ON l.id = p.location_id
    WHERE p.organization_id = ${organizationId} AND p.punch_type = 'in' AND ${EFFECTIVE} IN ('validated', 'justified')
      AND p.effective_at <= ${now.toISOString()}::timestamptz AND p.effective_at > ${now.toISOString()}::timestamptz - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM attendance_punches o WHERE o.shift_id = p.shift_id
        AND o.organization_worker_membership_id = p.organization_worker_membership_id AND o.punch_type = 'out'
        AND (o.session_in_punch_id = p.id OR (o.session_in_punch_id IS NULL AND o.effective_at > p.effective_at))
        AND COALESCE((SELECT r.decision FROM attendance_reviews r WHERE r.punch_id = o.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1), o.initial_validation) <> 'not_recognized')
    ORDER BY p.organization_worker_membership_id, p.effective_at DESC`.execute(trx)).rows;
  const counts = (await sql<{ pending: number; alerts: number }>`
    SELECT (SELECT count(*)::int FROM attendance_punches p WHERE p.organization_id = ${organizationId} AND ${EFFECTIVE} = 'pending_review') AS pending,
           (SELECT count(*)::int FROM attendance_alerts a WHERE a.organization_id = ${organizationId} AND a.acknowledged_at IS NULL) AS alerts`.execute(trx)).rows[0];
  return {
    present: present.map((r) => ({ workerName: r.worker_name, establishment: r.location_name, since: r.since }))
      .sort((a, b) => a.establishment.localeCompare(b.establishment, "es") || (a.workerName ?? "").localeCompare(b.workerName ?? "", "es")),
    pendingReview: counts?.pending ?? 0, openAlerts: counts?.alerts ?? 0,
  };
}

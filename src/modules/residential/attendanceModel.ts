/**
 * 174–175 · Hogares F4: reglas puras de los ponches (sin base de datos, para probarlas solas). Plan: D3, D4 y §5.
 *
 * - Geocerca: una sola lectura al ponchar; se calcula el estado y la distancia (redondeada a 10 m) y se descartan las
 *   coordenadas. Nunca se impide un ponche por la ubicación.
 * - Sin conexión: el reloj del teléfono lo controla el usuario, así que nunca se valida automáticamente; se marcan las
 *   horas en el futuro, la llegada después de 72 h, el desfase de más de 15 min y el orden imposible.
 * - Validado solo en línea, con código vigente (o en transición para salir), dentro del perímetro y sin marcas.
 * - Tardanzas, salidas anticipadas y ausencias: datos administrativos, nunca descuentos.
 */
export type PunchType = "in" | "out" | "break_start" | "break_end" | "meal_start" | "meal_end";
export type LocationStatus = "inside" | "outside" | "low_accuracy" | "unavailable";
export type CodeStatus = "current" | "transition" | "invalid" | "none";
export type PunchFlag =
  | "declared_in_future" | "before_code" | "outside_shift_window" | "clock_skew" | "impossible_order" | "received_after_72h"
  | "code_invalid" | "transition_not_for_entry" | "no_consent" | "no_geofence_center" | "duplicate_open_session";

export const FUTURE_TOLERANCE_MS = 2 * 60_000;
export const CLOCK_SKEW_MS = 15 * 60_000;
export const LATE_RECEIPT_MS = 72 * 3_600_000;
export const EARLY_WINDOW_MS = 60 * 60_000;          // entrada hasta 60 min antes del turno
export const LATE_WINDOW_MS = 4 * 3_600_000;         // hasta 4 h después del fin del turno
export const LONG_SESSION_MS = 16 * 3_600_000;

/** Distancia en metros entre dos puntos (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeoResult { status: LocationStatus; distanceM: number | null; accuracyM: number | null; flags: PunchFlag[] }
/**
 * Estado de ubicación. `reading` llega solo si la persona tiene consentimiento vigente y el teléfono dio una lectura.
 * Precisión baja: la precisión declarada supera el radio. Devuelve solo números redondeados: nunca coordenadas.
 */
export function geofenceStatus(input: {
  consent: boolean; reading: { lat: number; lng: number; accuracy: number } | null;
  center: { lat: number; lng: number } | null; radiusM: number;
}): GeoResult {
  if (!input.reading) return { status: "unavailable", distanceM: null, accuracyM: null, flags: [] };
  if (!input.consent) return { status: "unavailable", distanceM: null, accuracyM: null, flags: ["no_consent"] };
  if (!input.center) return { status: "unavailable", distanceM: null, accuracyM: null, flags: ["no_geofence_center"] };
  const accuracyM = Math.min(100_000, Math.max(0, Math.round(input.reading.accuracy)));
  const distanceM = Math.min(100_000, Math.round(distanceMeters(input.reading, input.center) / 10) * 10);
  if (accuracyM > input.radiusM) return { status: "low_accuracy", distanceM, accuracyM, flags: [] };
  return { status: distanceM <= input.radiusM ? "inside" : "outside", distanceM, accuracyM, flags: [] };
}

/** Marcas por la hora: futuro, recepción tardía y desfase (sin conexión) y ventana del turno (siempre). */
export function timeFlags(input: {
  offline: boolean; effectiveAt: Date; serverNow: Date; deviceNow: Date | null;
  type: PunchType; shiftStart: Date; shiftEnd: Date; codeValidFrom: Date | null;
}): PunchFlag[] {
  const f: PunchFlag[] = [];
  const t = input.effectiveAt.getTime(), now = input.serverNow.getTime();
  if (input.offline) {
    if (t > now + FUTURE_TOLERANCE_MS) f.push("declared_in_future");
    if (now - t > LATE_RECEIPT_MS) f.push("received_after_72h");
    if (input.deviceNow && Math.abs(input.deviceNow.getTime() - now) > CLOCK_SKEW_MS) f.push("clock_skew");
    if (input.codeValidFrom && t < input.codeValidFrom.getTime()) f.push("before_code");
  }
  if (t < input.shiftStart.getTime() - EARLY_WINDOW_MS || t > input.shiftEnd.getTime() + LATE_WINDOW_MS) f.push("outside_shift_window");
  return f;
}

export interface SessionState { openInId: string | null; openInCodeId: string | null; breakOpen: boolean; mealOpen: boolean }
/** Orden posible: entrada sin sesión abierta; el resto dentro de una sesión, con su pausa abierta o cerrada. */
export function orderAllowed(type: PunchType, s: SessionState): boolean {
  switch (type) {
    case "in": return s.openInId === null;
    case "out": return s.openInId !== null;
    case "break_start": return s.openInId !== null && !s.breakOpen && !s.mealOpen;
    case "break_end": return s.openInId !== null && s.breakOpen;
    case "meal_start": return s.openInId !== null && !s.mealOpen && !s.breakOpen;
    case "meal_end": return s.openInId !== null && s.mealOpen;
  }
}

/**
 * Estado del código para este ponche. El de transición solo vale para SALIR de una sesión abierta con él (nunca abre
 * una entrada ni cierra una sesión de otro código). Cualquier otro caso es «no vigente»: se guarda como declaración.
 */
export function codeStatusFor(input: {
  match: "current" | "transition" | null; type: PunchType; transitionCodeId: string | null; session: SessionState;
}): { status: CodeStatus; flags: PunchFlag[] } {
  if (input.match === "current") return { status: "current", flags: [] };
  if (input.match === "transition") {
    if (input.type === "out" && input.session.openInId && input.session.openInCodeId === input.transitionCodeId) return { status: "transition", flags: [] };
    return { status: "invalid", flags: [input.type === "in" ? "transition_not_for_entry" : "code_invalid"] };
  }
  return { status: "invalid", flags: ["code_invalid"] };
}

/** Validación inicial: solo en línea + código vigente o en transición + dentro + sin marcas. */
export function initialValidation(input: { offline: boolean; codeStatus: CodeStatus; location: LocationStatus; flags: PunchFlag[] }): "validated" | "pending_review" {
  return !input.offline && (input.codeStatus === "current" || input.codeStatus === "transition") && input.location === "inside" && input.flags.length === 0
    ? "validated" : "pending_review";
}

export type EffectiveStatus = "validated" | "pending_review" | "justified" | "not_recognized";

/** Política por defecto (175) cuando el establecimiento no tiene una propia. */
export const DEFAULT_POLICY = { transitionHours: 8, lateToleranceMinutes: 10, earlyLeaveToleranceMinutes: 10, absenceAfterMinutes: 60 };
export type Policy = typeof DEFAULT_POLICY;

export interface SummaryPunch { id: string; type: PunchType; at: Date; status: EffectiveStatus; sessionInId: string | null }
export interface ShiftAttendance {
  firstInAt: Date | null; lastOutAt: Date | null; lateMinutes: number; earlyLeaveMinutes: number; absent: boolean; openSession: boolean;
  validatedMinutes: number; pendingMinutes: number; breakMinutes: number; mealMinutes: number;
}
/**
 * Asistencia de una persona en un turno. No reconocido no cuenta, pero se conserva. Una sesión (entrada→salida) cuenta
 * como validada si sus dos extremos están validados o justificados; si no, como pendiente. Pausas y alimentos se
 * informan aparte (no se restan: el plan deja fuera los cálculos laborales).
 */
export function shiftAttendance(input: { start: Date; end: Date; now: Date; policy: Policy; punches: SummaryPunch[] }): ShiftAttendance {
  const ps = input.punches.filter((p) => p.status !== "not_recognized").sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const ok = (s: EffectiveStatus) => s === "validated" || s === "justified";
  let validated = 0, pending = 0, breaks = 0, meals = 0, open = false;
  const ins = ps.filter((p) => p.type === "in");
  for (const i of ins) {
    const out = ps.find((p) => p.type === "out" && (p.sessionInId === i.id || (p.sessionInId === null && p.at > i.at)) );
    if (!out) { open = true; continue; }
    const minutes = Math.max(0, Math.round((out.at.getTime() - i.at.getTime()) / 60_000));
    if (ok(i.status) && ok(out.status)) validated += minutes; else pending += minutes;
  }
  const pair = (startType: PunchType, endType: PunchType) => {
    let total = 0;
    for (const s of ps.filter((p) => p.type === startType)) {
      const e = ps.find((p) => p.type === endType && p.at >= s.at);
      if (e) total += Math.max(0, Math.round((e.at.getTime() - s.at.getTime()) / 60_000));
    }
    return total;
  };
  breaks = pair("break_start", "break_end");
  meals = pair("meal_start", "meal_end");
  const firstIn = ins[0]?.at ?? null;
  const outs = ps.filter((p) => p.type === "out");
  const lastOut = outs.length ? outs[outs.length - 1].at : null;
  const lateRaw = firstIn ? Math.round((firstIn.getTime() - input.start.getTime()) / 60_000) : 0;
  const earlyRaw = lastOut && !open ? Math.round((input.end.getTime() - lastOut.getTime()) / 60_000) : 0;
  return {
    firstInAt: firstIn, lastOutAt: lastOut,
    lateMinutes: lateRaw > input.policy.lateToleranceMinutes ? lateRaw : 0,
    earlyLeaveMinutes: earlyRaw > input.policy.earlyLeaveToleranceMinutes ? earlyRaw : 0,
    absent: !firstIn && input.now.getTime() > input.start.getTime() + input.policy.absenceAfterMinutes * 60_000,
    openSession: open, validatedMinutes: validated, pendingMinutes: pending, breakMinutes: breaks, mealMinutes: meals,
  };
}

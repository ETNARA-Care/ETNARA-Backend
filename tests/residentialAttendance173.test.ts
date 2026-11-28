import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { codeKeys, constantTimeEqual, parseQrPayload, pinCode, qrPayload, qrToken } from "../src/modules/residential/attendanceCodes.js";
import {
  codeStatusFor, DEFAULT_POLICY, geofenceStatus, initialValidation, orderAllowed, shiftAttendance, timeFlags,
} from "../src/modules/residential/attendanceModel.js";
import { consentSchema, correctionSchema, manualPunchSchema, policySchema, punchSchema, reviewSchema } from "../src/modules/residential/attendance.schemas.js";
import { residentialDbErrorCode, residentialDbErrorStatus } from "../src/modules/residential/residentialErrors.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const m173 = read("migrations/173_residential_attendance_codes.sql");
const m174 = read("migrations/174_residential_attendance_punches.sql");
const m175 = read("migrations/175_residential_attendance_review.sql");
const all = m173 + m174 + m175;
const service = read("src/modules/residential/attendance.service.ts");
const ORG = "11111111-2222-4333-8444-555555555555";
const LOC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEY = { keyId: "k1", secret: "s".repeat(40) };
const REF = { organizationId: ORG, locationId: LOC, weekStart: "2026-11-30", version: 1, keyId: "k1" };
const d = (iso: string) => new Date(iso);

describe("173–175: migraciones de ponches", () => {
  it("no modifican shifts ni encienden interruptores ni tocan organizaciones", () => {
    expect(all).not.toMatch(/ALTER TABLE\s+(public\.)?shifts|UPDATE\s+(public\.)?shifts|DELETE FROM\s+(public\.)?shifts/i);
    expect(all).not.toMatch(/INSERT INTO\s+(public\.)?organization_features|UPDATE\s+(public\.)?organization_features|UPDATE\s+(public\.)?organizations/i);
  });
  it("privacidad: ninguna columna de coordenadas, token, código o secreto en las tablas de asistencia", () => {
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (attendance_\w+) \(([\s\S]*?)\n\);/g)];
    expect(tables.length).toBe(9);
    for (const [, name, body] of tables) {
      const cols = body.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
      for (const c of cols) expect(`${name}.${c}`).not.toMatch(/\.(.*_)?(lat|lng|latitude|longitude|coords?|coordinates|token|pin|secret|qr)(_.*)?$/);
    }
  });
  it("RLS activa en las nueve tablas y app_runtime sin EXECUTE sobre las guardas", () => {
    for (const t of ["attendance_codes", "attendance_code_events", "attendance_code_attempts", "attendance_punches", "attendance_geo_consents",
      "attendance_policies", "attendance_reviews", "attendance_correction_requests", "attendance_alerts"]) {
      expect(all).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
    }
    expect(all).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.app_attendance_\w*guard[^;]*app_runtime/i);
    expect(all).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.app_attendance_notify_managers[^;]*app_runtime/i);
    // Las alertas solo las crean funciones del propietario.
    expect(m175).toMatch(/GRANT SELECT, UPDATE ON attendance_alerts TO app_runtime;/);
    // Los ponches no se actualizan ni se borran (sin permiso y con guarda).
    expect(m174).toMatch(/GRANT SELECT, INSERT ON attendance_punches TO app_runtime;/);
  });
  it("reglas del plan en la base: sin conexión nunca validado; validado solo en línea, vigente y dentro; transición solo para salir; manual con motivo", () => {
    expect(m174).toMatch(/CHECK \(origin <> 'offline' OR \(initial_validation = 'pending_review'/);
    expect(m174).toMatch(/CHECK \(initial_validation <> 'validated' OR \(origin = 'online' AND code_status IN \('current', 'transition'\)\s+AND location_status = 'inside' AND cardinality\(flags\) = 0\)\)/);
    expect(m174).toMatch(/CHECK \(code_status <> 'transition' OR punch_type = 'out'\)/);
    expect(m174).toMatch(/CHECK \(origin <> 'manual' OR \(manual_reason IS NOT NULL AND initial_validation = 'justified'/);
    expect(m174).toMatch(/distance_m % 10 = 0/);
  });
  it("nadie se revisa a sí mismo; las decisiones y los historiales son de solo añadir", () => {
    expect(m175).toMatch(/v_user = v_punch_user/);
    expect(m175).toMatch(/v_user = OLD\.user_id/);
    expect(m174).toMatch(/v_user = NEW\.user_id/);
    for (const t of ["attendance_code_events", "attendance_code_attempts", "attendance_policies", "attendance_reviews"]) {
      expect(all).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.app_residential_append_only\\(\\)`));
    }
  });
  it("la ventana del código la decide la semana, no quien escribe; versiones consecutivas; la revocación no se deshace", () => {
    expect(m173).toMatch(/NEW\.valid_from := \(NEW\.week_start::timestamp AT TIME ZONE 'America\/Puerto_Rico'\)/);
    expect(m173).toMatch(/NEW\.available_from := NEW\.valid_from - interval '72 hours'/);
    expect(m173).toMatch(/ATTENDANCE_CODE_VERSION_CONFLICT/);
    expect(m173).toMatch(/OLD\.revoked_at IS NOT NULL AND/);
  });
  it("las reversiones se niegan con datos de personas y respetan el orden", () => {
    expect(read("ops/175_residential_attendance_review.rollback.sql")).toMatch(/ROLLBACK_175_REFUSED/);
    expect(read("ops/174_residential_attendance_punches.rollback.sql")).toMatch(/revertir antes la 175/);
    expect(read("ops/173_residential_attendance_codes.rollback.sql")).toMatch(/revertir antes la 174/);
  });
  it("rutas detrás de HOGAR_PONCHES; códigos ATTENDANCE_* de la base con su estado", () => {
    expect(gatedFeatureFor(`/organizations/${ORG}/residential/attendance/me/punch`, "POST")?.feature).toBe("HOGAR_PONCHES");
    expect(gatedFeatureFor(`/organizations/${ORG}/residential/attendance/establishments`)?.feature).toBe("HOGAR_PONCHES");
    expect(residentialDbErrorCode({ code: "P0001", message: "ATTENDANCE_IMMUTABLE" })).toBe("ATTENDANCE_IMMUTABLE");
    expect(residentialDbErrorStatus("ATTENDANCE_NOT_AUTHORIZED")).toBe(403);
    expect(residentialDbErrorStatus("ATTENDANCE_SELF_REVIEW")).toBe(403);
    expect(residentialDbErrorStatus("ATTENDANCE_IMMUTABLE")).toBe(409);
  });
  it("sin secreto el servicio responde ATTENDANCE_UNAVAILABLE (nunca un código débil)", () => {
    expect(service).toMatch(/if \(!k\.current\) throw unavailable\(\);/);
    expect(service).toMatch(/"ATTENDANCE_UNAVAILABLE", 503/);
  });
});

describe("173: QR y código de 6 dígitos derivados", () => {
  it("deterministas y distintos por versión, establecimiento, organización, clave y dominio", () => {
    expect(qrToken(KEY, REF)).toBe(qrToken(KEY, REF));
    expect(qrToken(KEY, REF)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(pinCode(KEY, REF)).toMatch(/^\d{6}$/);
    const variants = [{ ...REF, version: 2 }, { ...REF, locationId: ORG }, { ...REF, organizationId: LOC }, { ...REF, weekStart: "2026-12-07" }];
    for (const v of variants) expect(qrToken(KEY, v)).not.toBe(qrToken(KEY, REF));
    expect(qrToken({ keyId: "k1", secret: "t".repeat(40) }, REF)).not.toBe(qrToken(KEY, REF));
    expect(pinCode(KEY, { ...REF, version: 2 })).not.toBe(pinCode(KEY, REF));
    expect(() => qrToken({ keyId: "k1", secret: "corto" }, REF)).toThrow();
  });
  it("el contenido del QR se lee de vuelta y se rechaza lo alterado o mal formado", () => {
    const payload = qrPayload(KEY, REF);
    expect(parseQrPayload(payload)).toEqual({ keyId: "k1", locationId: LOC, weekStart: "2026-11-30", version: 1, token: qrToken(KEY, REF) });
    for (const bad of [payload.replace("EA1", "EA2"), `${payload}.x`, payload.slice(0, -1), "x".repeat(300), 42, null, payload.replace(LOC, "no-es-uuid")]) {
      expect(parseQrPayload(bad)).toBeNull();
    }
  });
  it("comparación en tiempo constante y claves: la anterior solo para verificar", () => {
    expect(constantTimeEqual("123456", "123456")).toBe(true);
    expect(constantTimeEqual("123456", "123457")).toBe(false);
    expect(constantTimeEqual("123456", "12345")).toBe(false);
    const none = codeKeys({ ATTENDANCE_CODE_KEY_ID: "k1" });
    expect(none.current).toBeNull();
    const both = codeKeys({ ATTENDANCE_CODE_SECRET: "a".repeat(40), ATTENDANCE_CODE_KEY_ID: "k2", ATTENDANCE_CODE_PREVIOUS_SECRET: "b".repeat(40), ATTENDANCE_CODE_PREVIOUS_KEY_ID: "k1" });
    expect(both.current?.keyId).toBe("k2");
    expect([...both.byId.keys()].sort()).toEqual(["k1", "k2"]);
  });
});

describe("174–175: reglas puras de los ponches", () => {
  const center = { lat: 18.401234, lng: -66.051234 };
  it("geocerca: dentro, fuera, precisión baja, sin consentimiento, sin centro; solo números redondeados a 10 m", () => {
    const inside = geofenceStatus({ consent: true, center, radiusM: 100, reading: { lat: 18.401534, lng: -66.051234, accuracy: 15.4 } });
    expect(inside).toEqual({ status: "inside", distanceM: 30, accuracyM: 15, flags: [] });
    expect(geofenceStatus({ consent: true, center, radiusM: 100, reading: { lat: 18.409876, lng: -66.051234, accuracy: 10 } }).status).toBe("outside");
    expect(geofenceStatus({ consent: true, center, radiusM: 100, reading: { lat: 18.4013, lng: -66.0512, accuracy: 450 } }).status).toBe("low_accuracy");
    expect(geofenceStatus({ consent: false, center, radiusM: 100, reading: { lat: 18.4013, lng: -66.0512, accuracy: 5 } })).toEqual({ status: "unavailable", distanceM: null, accuracyM: null, flags: ["no_consent"] });
    expect(geofenceStatus({ consent: true, center: null, radiusM: 100, reading: { lat: 18.4013, lng: -66.0512, accuracy: 5 } }).flags).toEqual(["no_geofence_center"]);
    expect(geofenceStatus({ consent: true, center, radiusM: 100, reading: null })).toEqual({ status: "unavailable", distanceM: null, accuracyM: null, flags: [] });
    expect(JSON.stringify(inside)).not.toMatch(/18\.4|66\.05/);
  });
  it("marcas de hora: futuro, recepción tardía, desfase, antes del código y fuera de la ventana del turno", () => {
    const base = { type: "in" as const, shiftStart: d("2026-12-07T11:00:00Z"), shiftEnd: d("2026-12-07T19:00:00Z"), codeValidFrom: d("2026-12-07T04:00:00Z") };
    const now = d("2026-12-07T12:00:00Z");
    expect(timeFlags({ ...base, offline: true, effectiveAt: d("2026-12-07T12:30:00Z"), serverNow: now, deviceNow: d("2026-12-07T12:30:00Z") })).toEqual(["declared_in_future", "clock_skew"]);
    expect(timeFlags({ ...base, offline: true, effectiveAt: d("2026-12-04T11:00:00Z"), serverNow: now, deviceNow: null })).toEqual(["received_after_72h", "before_code", "outside_shift_window"]);
    expect(timeFlags({ ...base, offline: false, effectiveAt: d("2026-12-07T10:30:00Z"), serverNow: now, deviceNow: null })).toEqual([]);
    expect(timeFlags({ ...base, offline: false, effectiveAt: d("2026-12-07T09:30:00Z"), serverNow: now, deviceNow: null })).toEqual(["outside_shift_window"]);
  });
  it("máquina de estados y código en transición (solo para salir de una sesión abierta con él)", () => {
    const closed = { openInId: null, openInCodeId: null, breakOpen: false, mealOpen: false };
    const open = { openInId: "i", openInCodeId: "old", breakOpen: false, mealOpen: false };
    expect(orderAllowed("in", closed)).toBe(true);
    expect(orderAllowed("out", closed)).toBe(false);
    expect(orderAllowed("break_end", open)).toBe(false);
    expect(orderAllowed("meal_start", { ...open, breakOpen: true })).toBe(false);
    expect(codeStatusFor({ match: "transition", type: "out", transitionCodeId: "old", session: open })).toEqual({ status: "transition", flags: [] });
    expect(codeStatusFor({ match: "transition", type: "in", transitionCodeId: "old", session: closed })).toEqual({ status: "invalid", flags: ["transition_not_for_entry"] });
    expect(codeStatusFor({ match: "transition", type: "out", transitionCodeId: "old", session: { ...open, openInCodeId: "new" } }).status).toBe("invalid");
    expect(codeStatusFor({ match: null, type: "in", transitionCodeId: null, session: closed })).toEqual({ status: "invalid", flags: ["code_invalid"] });
  });
  it("validación inicial: solo en línea + vigente + dentro + sin marcas", () => {
    expect(initialValidation({ offline: false, codeStatus: "current", location: "inside", flags: [] })).toBe("validated");
    expect(initialValidation({ offline: true, codeStatus: "current", location: "inside", flags: [] })).toBe("pending_review");
    expect(initialValidation({ offline: false, codeStatus: "current", location: "unavailable", flags: [] })).toBe("pending_review");
    expect(initialValidation({ offline: false, codeStatus: "invalid", location: "inside", flags: [] })).toBe("pending_review");
    expect(initialValidation({ offline: false, codeStatus: "current", location: "inside", flags: ["outside_shift_window"] })).toBe("pending_review");
  });
  it("asistencia del turno: tardanza, salida anticipada, ausencia; validadas y pendientes por separado; «no reconocido» no cuenta", () => {
    const start = d("2026-12-07T11:00:00Z"), end = d("2026-12-07T19:00:00Z");
    const r = shiftAttendance({ start, end, now: d("2026-12-07T20:00:00Z"), policy: DEFAULT_POLICY, punches: [
      { id: "a", type: "in", at: d("2026-12-07T11:25:00Z"), status: "validated", sessionInId: null },
      { id: "b", type: "break_start", at: d("2026-12-07T14:00:00Z"), status: "validated", sessionInId: "a" },
      { id: "c", type: "break_end", at: d("2026-12-07T14:15:00Z"), status: "validated", sessionInId: "a" },
      { id: "x", type: "out", at: d("2026-12-07T13:00:00Z"), status: "not_recognized", sessionInId: "a" },
      { id: "e", type: "out", at: d("2026-12-07T18:30:00Z"), status: "pending_review", sessionInId: "a" },
    ] });
    expect(r).toMatchObject({ lateMinutes: 25, earlyLeaveMinutes: 30, absent: false, openSession: false, validatedMinutes: 0, pendingMinutes: 425, breakMinutes: 15 });
    const absent = shiftAttendance({ start, end, now: d("2026-12-07T12:01:00Z"), policy: DEFAULT_POLICY, punches: [] });
    expect(absent.absent).toBe(true);
    const onTime = shiftAttendance({ start, end, now: d("2026-12-07T11:30:00Z"), policy: DEFAULT_POLICY, punches: [{ id: "a", type: "in", at: d("2026-12-07T11:05:00Z"), status: "validated", sessionInId: null }] });
    expect(onTime).toMatchObject({ lateMinutes: 0, absent: false, openSession: true });
  });
  it("esquemas: un solo código, la hora declarada sin conexión, motivo obligatorio y versión de consentimiento", () => {
    const base = { clientEventId: ORG, shiftId: LOC, type: "in" };
    expect(punchSchema.safeParse({ ...base, method: "pin", pin: "123456" }).success).toBe(true);
    expect(punchSchema.safeParse({ ...base, method: "pin", pin: "123456", qr: "x" }).success).toBe(false);
    expect(punchSchema.safeParse({ ...base, method: "qr" }).success).toBe(false);
    expect(punchSchema.safeParse({ ...base, method: "pin", pin: "12345" }).success).toBe(false);
    expect(punchSchema.safeParse({ ...base, method: "pin", pin: "123456", offline: true }).success).toBe(false);
    expect(punchSchema.safeParse({ ...base, method: "pin", pin: "123456", latitude: 18 }).success).toBe(false);
    expect(consentSchema.safeParse({ version: "geo-0", accept: true }).success).toBe(false);
    expect(reviewSchema.safeParse({ punchIds: [ORG], decision: "validated", reason: "ok" }).success).toBe(false);
    expect(reviewSchema.safeParse({ punchIds: [], decision: "validated", reason: "Revisado" }).success).toBe(false);
    expect(manualPunchSchema.safeParse({ shiftId: ORG, membershipId: LOC, type: "out", at: "2026-12-07T11:00:00Z" }).success).toBe(false);
    expect(correctionSchema.safeParse({ shiftId: ORG, type: "in", requestedAt: "2026-12-07T11:00:00Z", reason: "Sin señal" }).success).toBe(true);
    expect(policySchema.safeParse({ transitionHours: 13, lateToleranceMinutes: 5, earlyLeaveToleranceMinutes: 5, absenceAfterMinutes: 30, reason: "Ajuste" }).success).toBe(false);
  });
});

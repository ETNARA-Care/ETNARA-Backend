import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { DEFAULT_POLICY, shiftAttendance } from "../src/modules/residential/attendanceModel.js";
import {
  assignResidentsSchema, redistributeSchema, substitutionPreviewSchema, substitutionSchema, SUBSTITUTION_REASONS,
} from "../src/modules/residential/residentAssignments.schemas.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const m176 = read("migrations/176_residential_resident_assignments.sql");
const rb176 = read("ops/176_residential_resident_assignments.rollback.sql");
const service = read("src/modules/residential/residentAssignments.service.ts");
const U = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

describe("176: migración", () => {
  it("no modifica shifts ni enciende interruptores ni toca organizaciones", () => {
    expect(m176).not.toMatch(/ALTER TABLE\s+(public\.)?shifts\b|UPDATE\s+(public\.)?shifts\b|DELETE FROM\s+(public\.)?shifts\b/i);
    expect(m176).not.toMatch(/INSERT INTO\s+(public\.)?organization_features|UPDATE\s+(public\.)?organization_features|UPDATE\s+(public\.)?organizations\b/i);
  });
  it("RLS en las tres tablas; las sustituciones no se actualizan ni se borran; los periodos no se borran", () => {
    for (const t of ["shift_resident_assignments", "shift_substitutions", "shift_coverage_alerts"]) expect(m176).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
    expect(m176).toMatch(/GRANT SELECT, INSERT ON shift_substitutions TO app_runtime;/);
    expect(m176).not.toMatch(/GRANT[^;]*DELETE[^;]*TO app_runtime/);
  });
  it("las guardas no son ejecutables por app_runtime; las ayudas de acceso sí", () => {
    for (const g of ["app_residential_assignment_guard", "app_residential_substitution_guard", "app_residential_coverage_alert_guard", "app_residential_close_resident_assignments"]) {
      expect(m176).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${g}\\(\\) FROM PUBLIC;`));
      expect(m176).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${g}\\(`));
    }
  });
  it("el motivo es una categoría cerrada y la nota está limitada (sin campos de salud)", () => {
    expect(m176).toMatch(/reason_code\s+text NOT NULL CHECK \(reason_code IN \('unplanned_absence', 'operational', 'schedule_change', 'other'\)\)/);
    expect(m176).toMatch(/char_length\(reason_note\) <= 300/);
    expect(m176).not.toMatch(/diagnos|medical|health|illness|enfermedad/i);
  });
  it("las ramas nuevas de acceso se añaden a las funciones compartidas sin quitar las ramas existentes", () => {
    expect(m176).toMatch(/OR public\.app_residential_worker_has_recipient\(p_care_recipient_id\)/);
    expect(m176).toMatch(/OR public\.app_residential_user_has_recipient_now\(/);
  });
  it("la transferencia a quien ya atiende al residente no duplica su periodo", () => {
    expect(m176).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM shift_resident_assignments y WHERE y\.shift_id = p_shift_id/);
    expect(service).toMatch(/already = m\.toMembershipId && sras\.some/);
  });
  it("la reversión se niega con datos y restaura las funciones compartidas", () => {
    expect(rb176).toMatch(/ROLLBACK_176_REFUSED/);
    for (const f of ["app_worker_has_recipient_assignment", "app_worker_messaging_window", "app_attendance_my_shifts"]) expect(rb176).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION (public\\.)?${f}\\(`));
    expect(rb176).toMatch(/DELETE FROM schema_migrations WHERE filename = '176_residential_resident_assignments\.sql'/);
  });
});

describe("176: interruptores", () => {
  it("asignaciones bajo HOGAR_ASIGNACIONES; las sustituciones las decide el servicio (403 con cualquiera apagado)", () => {
    expect(gatedFeatureFor(`/organizations/${U(1)}/residential/assignments/establishments`)?.feature).toBe("HOGAR_ASIGNACIONES");
    expect(gatedFeatureFor(`/organizations/${U(1)}/residential/substitutions/shifts/${U(2)}`)).toBeNull();
    expect(service).toMatch(/RESIDENTIAL_SUBSTITUTION_NOT_AVAILABLE/);
    expect(service).toMatch(/HOGAR_CALENDARIO/);
    expect(service).toMatch(/HOGAR_ASIGNACIONES/);
  });
});

describe("176: esquemas", () => {
  it("asignar exige al menos un residente, sin duplicados ni campos extra", () => {
    expect(assignResidentsSchema.safeParse({ membershipId: U(1), careRecipientIds: [] }).success).toBe(false);
    expect(assignResidentsSchema.safeParse({ membershipId: U(1), careRecipientIds: [U(2)] }).success).toBe(true);
    expect(assignResidentsSchema.safeParse({ membershipId: U(1), careRecipientIds: [U(2)], extra: 1 }).success).toBe(false);
  });
  it("redistribuir sin destino es posible; el motivo de la falta de cobertura está limitado", () => {
    expect(redistributeSchema.safeParse({ moves: [{ careRecipientId: U(1), fromMembershipId: U(2), toMembershipId: null }] }).success).toBe(true);
    expect(redistributeSchema.safeParse({ moves: [{ careRecipientId: U(1), fromMembershipId: U(2), toMembershipId: null }], confirmUncovered: true, uncoveredReason: "x".repeat(301) }).success).toBe(false);
  });
  it("sustitución: categoría obligatoria, nota ≤ 300, sin forma de anular bloqueos", () => {
    const base = { originalMembershipId: U(1), substituteMembershipId: U(2), reasonCode: "operational" };
    expect(SUBSTITUTION_REASONS).toEqual(["unplanned_absence", "operational", "schedule_change", "other"]);
    expect(substitutionSchema.safeParse(base).success).toBe(true);
    expect(substitutionSchema.safeParse({ ...base, reasonCode: undefined }).success).toBe(false);
    expect(substitutionSchema.safeParse({ ...base, reasonCode: "illness" }).success).toBe(false);
    expect(substitutionSchema.safeParse({ ...base, reasonNote: "x".repeat(301) }).success).toBe(false);
    expect(substitutionSchema.safeParse({ ...base, override: true }).success).toBe(false);
    expect(substitutionSchema.safeParse({ ...base, ignoreBlocks: true }).success).toBe(false);
    expect(substitutionPreviewSchema.safeParse({ originalMembershipId: U(1), substituteMembershipId: U(2) }).success).toBe(true);
  });
});

describe("176: horas sin duplicar", () => {
  const start = new Date("2026-11-26T12:00:00Z"), end = new Date("2026-11-26T20:00:00Z"), T = new Date("2026-11-26T14:00:00Z");
  const p = (id: string, type: "in" | "out", at: string, sessionInId: string | null = null) =>
    ({ id, type, at: new Date(at), status: "validated" as const, sessionInId });
  const punches = [p("a", "in", "2026-11-26T12:00:00Z"), p("b", "out", "2026-11-26T15:00:00Z", "a")];
  it("la original cuenta solo hasta la hora efectiva aunque su salida sea posterior; el ponche no cambia", () => {
    const r = shiftAttendance({ start, end, now: end, policy: DEFAULT_POLICY, punches, clip: { from: null, to: T } });
    expect(r.validatedMinutes + r.pendingMinutes).toBe(120);
    expect(punches[1].at.toISOString()).toBe("2026-11-26T15:00:00.000Z");
  });
  it("la sustituta cuenta desde la hora efectiva aunque entre antes", () => {
    const sub = [p("c", "in", "2026-11-26T13:30:00Z"), p("d", "out", "2026-11-26T20:00:00Z", "c")];
    const r = shiftAttendance({ start, end, now: end, policy: DEFAULT_POLICY, punches: sub, clip: { from: T, to: null } });
    expect(r.validatedMinutes + r.pendingMinutes).toBe(360);
  });
  it("sin sustitución no se recorta nada (comportamiento de F4 intacto)", () => {
    const r = shiftAttendance({ start, end, now: end, policy: DEFAULT_POLICY, punches });
    expect(r.validatedMinutes + r.pendingMinutes).toBe(180);
  });
});

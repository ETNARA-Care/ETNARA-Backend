import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import {
  applyTemplateSchema, copyWeekSchema, createEntrySchema, createTemplateSchema, isMonday, updateEntrySchema, updateTemplateSchema,
} from "../src/modules/residential/residentialSchedule.schemas.js";
import { addDays, localDate, minutesByLocalDay, scheduleSummary, scheduleWarnings } from "../src/modules/residential/residentialScheduleModel.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const mig = read("migrations/172_residential_weekly_schedule.sql");
const rollback = read("ops/172_residential_weekly_schedule.rollback.sql");
const app = read("src/app.ts");
const scheduling = read("src/modules/scheduling/scheduling.service.ts");
const ID = "11111111-2222-4333-8444-555555555555";
const at = (iso: string) => new Date(iso);
const e = (id: string, s: string, end: string, m: string | null = "w1") => ({ id, startsAt: at(s), endsAt: at(end), membershipId: m, requiredRole: "caregiver" });

describe("172: hogares F2 (calendario semanal)", () => {
  it("no modifica la estructura de shifts ni enciende interruptores", () => {
    expect(mig).not.toMatch(/ALTER TABLE\s+(public\.)?shifts|DROP\s+\w+\s+.*\bshifts\b/i);
    expect(mig).not.toMatch(/INSERT INTO\s+(public\.)?organization_features|UPDATE\s+(public\.)?organizations/i);
    expect(rollback).not.toMatch(/ALTER TABLE\s+(public\.)?shifts|DELETE FROM\s+(public\.)?shifts/i);
  });
  it("RLS activa en las cinco tablas y app_runtime sin EXECUTE sobre las guardas", () => {
    for (const t of ["schedule_templates", "schedule_template_slots", "schedule_weeks", "schedule_week_shifts", "schedule_week_publications"]) {
      expect(mig).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
      expect(mig).toMatch(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
    }
    expect(mig).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.app_schedule_\w+_guard[^;]*app_runtime/i);
  });
  it("las publicaciones son de solo añadir y la reversión se niega si hay datos publicados", () => {
    expect(mig).toMatch(/schedule_week_publications[\s\S]*app_residential_append_only/);
    expect(rollback).toMatch(/ROLLBACK_172_REFUSED/);
    expect(rollback).toMatch(/schedule_week_publications/);
    expect(rollback).toMatch(/shift_id IS NOT NULL/);
  });
  it("las rutas van detrás de HOGAR_CALENDARIO y están registradas", () => {
    expect(gatedFeatureFor(`/organizations/${ID}/residential/schedule/establishments`)?.feature).toBe("HOGAR_CALENDARIO");
    expect(gatedFeatureFor(`/organizations/${ID}/residential/schedule`, "POST")?.feature).toBe("HOGAR_CALENDARIO");
    expect(gatedFeatureFor(`/organizations/${ID}/residential/establishments`)?.feature).not.toBe("HOGAR_CALENDARIO");
    expect(app).toMatch(/residentialScheduleRoutes/);
  });
  it("las respuestas de turnos nunca exponen la habitación técnica", () => {
    const masked = scheduling.match(/CASE WHEN app_is_technical_room\(s?\.?room_id\) THEN NULL ELSE s?\.?room_id END AS room_id/g) ?? [];
    expect(masked.length).toBeGreaterThanOrEqual(6);
    expect(scheduling).toMatch(/AS establishment_name/);
  });

  it("isMonday solo acepta lunes reales", () => {
    expect(isMonday("2026-12-07")).toBe(true);
    expect(isMonday("2026-12-08")).toBe(false);
    expect(isMonday("2026-02-30")).toBe(false);
    expect(isMonday("2026-12-7")).toBe(false);
  });
  it("esquemas: límites de duración, hora local sin zona y campos desconocidos rechazados", () => {
    expect(createEntrySchema.safeParse({ startsAt: "2026-12-07T07:00", durationMinutes: 480 }).success).toBe(true);
    expect(createEntrySchema.safeParse({ startsAt: "2026-12-07T07:00Z", durationMinutes: 480 }).success).toBe(false);
    expect(createEntrySchema.safeParse({ startsAt: "2026-12-07T07:00", durationMinutes: 10 }).success).toBe(false);
    expect(createEntrySchema.safeParse({ startsAt: "2026-12-07T07:00", durationMinutes: 1441 }).success).toBe(false);
    expect(createEntrySchema.safeParse({ startsAt: "2026-12-07T07:00", durationMinutes: 60, careRecipientId: ID }).success).toBe(false);
    expect(updateEntrySchema.safeParse({}).success).toBe(false);
    expect(copyWeekSchema.safeParse({ fromWeekStart: "2026-11-30" }).success).toBe(true);
    expect(applyTemplateSchema.safeParse({ templateId: "x" }).success).toBe(false);
    const slot = { weekday: 1, startTime: "23:00", durationMinutes: 480 };
    expect(createTemplateSchema.safeParse({ name: "Base", slots: [slot] }).success).toBe(true);
    expect(createTemplateSchema.safeParse({ name: "Base", slots: [{ ...slot, weekday: 8 }] }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ name: "Base", slots: [{ ...slot, startTime: "24:00" }] }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ name: "Base", slots: [] }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ archived: true }).success).toBe(true);
  });
  it("hora local de Puerto Rico (UTC−4, sin horario de verano)", () => {
    expect(localDate(at("2026-12-08T03:59:00Z"))).toBe("2026-12-07");
    expect(localDate(at("2026-12-08T04:00:00Z"))).toBe("2026-12-08");
    expect(localDate(at("2026-07-01T03:00:00Z"))).toBe("2026-06-30");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
  it("un turno nocturno reparte sus horas entre los dos días", () => {
    // 23:00–07:00 locales = 03:00–11:00 UTC del día siguiente.
    const m = minutesByLocalDay(at("2026-12-08T03:00:00Z"), at("2026-12-08T11:00:00Z"));
    expect([...m]).toEqual([["2026-12-07", 60], ["2026-12-08", 420]]);
  });
  it("avisos: solape y duplicado de la misma persona; plazas vacías no se comparan; turnos seguidos no avisan", () => {
    const w = scheduleWarnings([
      e("a", "2026-12-07T11:00:00Z", "2026-12-07T19:00:00Z"),
      e("b", "2026-12-07T11:00:00Z", "2026-12-07T19:00:00Z"),
      e("c", "2026-12-07T18:00:00Z", "2026-12-08T02:00:00Z"),
      e("d", "2026-12-08T02:00:00Z", "2026-12-08T10:00:00Z"),
      e("x", "2026-12-07T11:00:00Z", "2026-12-07T19:00:00Z", null),
      e("y", "2026-12-07T11:00:00Z", "2026-12-07T19:00:00Z", null),
    ]);
    expect(w.filter((x) => x.type === "duplicate").map((x) => x.entryIds)).toEqual([["a", "b"]]);
    expect(w.filter((x) => x.type === "overlap").map((x) => x.entryIds.join())).toEqual(["a,c", "b,c"]);
    expect(w.some((x) => x.entryIds.includes("d") || x.entryIds.includes("x"))).toBe(false);
  });
  it("resumen: total, por persona, por día y plazas sin asignar", () => {
    const s = scheduleSummary([
      e("a", "2026-12-08T03:00:00Z", "2026-12-08T11:00:00Z"),
      e("b", "2026-12-07T11:00:00Z", "2026-12-07T15:00:00Z", "w2"),
      e("c", "2026-12-07T11:00:00Z", "2026-12-07T15:00:00Z", null),
    ]);
    expect(s.totalMinutes).toBe(480 + 240 + 240);
    expect(s.unassignedEntries).toBe(1);
    expect(s.byWorker).toEqual([{ membershipId: "w1", minutes: 480 }, { membershipId: "w2", minutes: 240 }]);
    expect(s.byDay).toEqual([{ date: "2026-12-07", minutes: 60 + 240 + 240 }, { date: "2026-12-08", minutes: 420 }]);
  });
});

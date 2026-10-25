import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { renderShiftReportPdf, type FamilyShiftReport } from "../src/modules/shiftReports/shiftReportPdf.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";
const R = "66666666-7777-4888-9999-000000000000";
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const sample = (n: number): FamilyShiftReport => ({
  id: ID, version: 1, status: "APPROVED", approvedAt: "2026-10-25T18:00:00.000Z", serviceDate: "2026-10-25",
  organization: { name: "Cuidado en Casa Demo" }, recipient: { name: "Doña Carmen" }, caregiver: { name: "María Rivera Demo" },
  agencySummary: "Turno tranquilo.", shown: ["schedule", "meals", "observations"],
  sections: {
    schedule: { scheduledStart: "2026-10-25T12:00:00.000Z", scheduledEnd: "2026-10-25T16:00:00.000Z", arrivalAt: null, startAt: "2026-10-25T12:02:00.000Z", endAt: "2026-10-25T16:01:00.000Z" },
    meals: Array.from({ length: n }, (_, i) => ({ at: "2026-10-25T13:00:00.000Z", mealType: "Snack", amountConsumed: "Todo", note: `Nota ${i}` })),
    observations: { notes: [], caregiverNote: null },
  },
});

describe("Informe de Turno F3 (129)", () => {
  const code = read("migrations/129_shift_reports_family.sql").replace(/--.*$/gm, "");
  const family = read("src/modules/shiftReports/shiftReportsFamily.service.ts");
  const pdf = read("src/modules/shiftReports/shiftReportPdf.ts");

  it("family routes are behind SHIFT_REPORTS", () => {
    expect(gatedFeatureFor(`/organizations/${O}/care-recipients/${R}/shift-reports`)).toMatchObject({ feature: "SHIFT_REPORTS" });
    expect(gatedFeatureFor(`/organizations/${O}/care-recipients/${R}/shift-reports/${ID}/pdf`)).toMatchObject({ feature: "SHIFT_REPORTS" });
  });

  it("only APPROVED, only active family + FAMILY role, never central; no table or policy changes", () => {
    expect(code).toMatch(/NOT public\.app_is_superadmin\(\)/);
    expect(code).toMatch(/fr\.status = 'active'/);
    expect(code).toMatch(/r\.code = 'FAMILY'/);
    expect(code).toMatch(/feature_code = 'SHIFT_REPORTS' AND f\.enabled/);
    expect(code).toMatch(/status = 'APPROVED'/);
    expect(code).not.toMatch(/CREATE POLICY|ALTER TABLE|CREATE TABLE|GRANT SELECT/);
    expect(code).not.toMatch(/(UPDATE|DELETE FROM)\s+(public\.)?\w+/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION app_shift_report_family_list\(uuid\) TO app_runtime;/);
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION app_shift_report_family_project/);
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION app_is_my_family_recipient/);
  });

  it("the projection drops internal ids and never touches photos, proximity or offline flags", () => {
    expect(code).toMatch(/e - 'careEventId'/);
    expect(code).not.toMatch(/'proximity'|'recordedOffline'|'photos'|'totals'|'membershipId'/);
  });

  it("PDF: rendered from the family projection, private download, no names in the file name", () => {
    expect(family).toMatch(/app_shift_report_family_pdf\(/);
    expect(family).toMatch(/"Cache-Control", "no-store, private"/);
    expect(family).toMatch(/attachment; filename=/);
    expect(family).toMatch(/informe-de-turno-\$\{report\.serviceDate\}-\$\{report\.id\.slice\(0, 8\)\}\.pdf/);
    expect(pdf).not.toMatch(/console\./); // never logs report content
  });

  it("renders a one-page PDF and paginates long reports with a footer on every page", async () => {
    const short = await renderShiftReportPdf(sample(3));
    expect(short.subarray(0, 5).toString()).toBe("%PDF-");
    expect((short.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    const long = await renderShiftReportPdf(sample(60));
    const pages = (long.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(6);
  });
});

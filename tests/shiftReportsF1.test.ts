import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";
const S = "66666666-7777-4888-9999-000000000000";

describe("Informe de Turno F1 (124)", () => {
  const m124 = read("migrations/124_shift_reports.sql");
  const code = m124.replace(/--.*$/gm, "");
  const rollback = read("ops/124_shift_reports.rollback.sql").replace(/--.*$/gm, "");
  const assessment = read("ops/124_shift_reports_rollback_assessment.sql").replace(/--.*$/gm, "");
  const service = read("src/modules/shiftReports/shiftReports.service.ts");
  const phi = read("scripts/verifyPlatformPhiBoundary.ts");

  it("is additive: never writes the source records and creates no switch row", () => {
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER TABLE (care_events|verification_events|shift_arrivals|incidents|observations)/i);
    expect(code).not.toMatch(/INSERT INTO organization_features/);
    expect(code).toContain("'SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'");
    // The service only reads the source tables.
    expect(service).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(care_events|verification_events|shift_arrivals|incidents|observations)\b/);
  });

  it("explicit grants (066 lesson), no DELETE, append-only history, FORCE RLS", () => {
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON shift_reports TO app_runtime;/);
    expect(code).toMatch(/GRANT SELECT, INSERT ON shift_report_events TO app_runtime;/);
    expect(code).not.toMatch(/GRANT[^;]*DELETE/);
    expect(code).toMatch(/ALTER TABLE shift_reports FORCE ROW LEVEL SECURITY;/);
    expect(code).toMatch(/ALTER TABLE shift_report_events FORCE ROW LEVEL SECURITY;/);
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON shift_report_events/);
    expect(code).toMatch(/SHIFT_REPORT_HISTORY_APPEND_ONLY/);
  });

  it("managers of the current organization only; central denied; policies use app.current_org_id", () => {
    expect(code).toMatch(/CREATE POLICY shift_reports_manager ON shift_reports FOR ALL TO app_runtime[\s\S]*app_is_org_manager\(\)/);
    expect(code).not.toMatch(/current_organization_id/); // the setting the app never sets (066 bug)
    expect(code.match(/current_setting\('app\.current_org_id', true\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/CREATE POLICY platform_phi_deny ON shift_reports AS RESTRICTIVE/);
    expect(code).toMatch(/CREATE POLICY platform_phi_deny ON shift_report_events AS RESTRICTIVE/);
    expect(phi).toMatch(/"shift_reports", "shift_report_events"/);
    // F1 gives caregivers and families no policy at all.
    expect(code).not.toMatch(/app_current_worker_ids|family_relationships/);
  });

  it("approved reports never change; reports are never deleted; new ones need SHIFT_REPORTS", () => {
    expect(code).toMatch(/SHIFT_REPORT_APPROVED_IMMUTABLE/);
    expect(code).toMatch(/SHIFT_REPORT_NOT_DELETABLE/);
    expect(code).toMatch(/BEFORE INSERT ON shift_reports\s+FOR EACH ROW EXECUTE FUNCTION app_require_org_feature\('SHIFT_REPORTS'\)/);
    expect(service).toMatch(/expectedGeneratedAt/);
  });

  it("nothing invented: no plan tasks, defaults decided by ETNARA for the family view", () => {
    expect(service).not.toMatch(/care_plans|plan_details/);
    expect(service).toMatch(/schedule: true, meals: true, hydration: true, activities: true, mobility: true, observations: true,\s+hygiene: false, mood: false, incidents: false, photos: false/);
  });

  it("routes are behind SHIFT_REPORTS", () => {
    expect(gatedFeatureFor(`/organizations/${O}/shift-reports`)).toMatchObject({ organizationId: O, feature: "SHIFT_REPORTS" });
    expect(gatedFeatureFor(`/organizations/${O}/shift-reports/${S}/approve`, "POST")).toMatchObject({ feature: "SHIFT_REPORTS" });
    expect(gatedFeatureFor(`/organizations/${O}/shifts/${S}/reports`)).toMatchObject({ feature: "SHIFT_REPORTS" });
  });

  it("recovery: read-only assessment; rollback aborts when reports or switch history exist", () => {
    expect(assessment).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(assessment).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    expect(rollback).toMatch(/shift reports exist: rollback aborted/);
    expect(rollback).toMatch(/SHIFT_REPORTS switch history exists: rollback aborted/);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '124_shift_reports\.sql'/);
  });
});

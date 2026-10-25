import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";
const R = "66666666-7777-4888-9999-000000000000";

describe("Informe de Turno F2 (128)", () => {
  const code = read("migrations/128_shift_reports_caregiver_review.sql").replace(/--.*$/gm, "");
  const rollback = read("ops/128_shift_reports_caregiver_review.rollback.sql").replace(/--.*$/gm, "");
  const service = read("src/modules/shiftReports/shiftReports.service.ts");
  const caregiver = read("src/modules/shiftReports/shiftReportsCaregiver.service.ts");

  it("one builder in the database; the TS builder is gone; source records only read", () => {
    expect(code).toMatch(/FUNCTION app_shift_report_build_content\(p_org uuid, p_shift uuid, p_membership uuid\)/);
    expect(service).not.toMatch(/async function buildContent/);
    expect(code).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.)?(care_events|verification_events|shift_arrivals|incidents|observations)\b/);
    expect(code).not.toMatch(/care_plans|plan_details/);
  });

  it("the builder and internal helpers are not executable by the app role", () => {
    const grant = code.slice(code.indexOf("GRANT EXECUTE ON FUNCTION"));
    for (const internal of ["app_shift_report_build_content", "app_shift_report_create_draft", "app_shift_report_visits", "app_shift_report_lock_own"]) {
      expect(grant).not.toContain(internal);
    }
    expect(code).toMatch(/REVOKE ALL ON FUNCTION [\s\S]*app_shift_report_build_content\(uuid, uuid, uuid\)[\s\S]*FROM PUBLIC;/);
  });

  it("caregiver: read-only RLS on her own visits; writes only through guarded functions within 24 h", () => {
    expect(code).toMatch(/CREATE POLICY shift_reports_own_visit_read ON shift_reports FOR SELECT TO app_runtime/);
    expect(code).not.toMatch(/CREATE POLICY shift_reports_own_visit_\w+ ON shift_reports FOR (UPDATE|INSERT|DELETE|ALL)/);
    expect(code).toMatch(/now\(\) > r\.review_deadline_at THEN RAISE EXCEPTION 'SHIFT_REPORT_WINDOW_CLOSED'/);
    expect(code).toMatch(/r\.status NOT IN \('DRAFT', 'RETURNED'\) THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_EDITABLE'/);
    expect(code).toMatch(/\(c->'times'->'end'->>'at'\)::timestamptz \+ interval '24 hours'/);
    expect(caregiver).not.toMatch(/familySections|agency_summary/);
  });

  it("expired windows keep the draft; nothing is deleted", () => {
    expect(code).not.toMatch(/DELETE FROM public\.shift_reports|DELETE FROM shift_reports/);
    expect(service).toMatch(/const windowExpired = \(r: ReportRow\) => r\.status === "DRAFT"/);
  });

  it("approved reports stay immutable including the caregiver columns", () => {
    for (const col of ["caregiver_note", "caregiver_note_at", "submitted_at", "review_deadline_at"]) {
      expect(code).toContain(`NEW.${col} IS NOT DISTINCT FROM OLD.${col}`);
    }
  });

  it("routes are behind SHIFT_REPORTS", () => {
    expect(gatedFeatureFor(`/organizations/${O}/me/shift-reports`)).toMatchObject({ feature: "SHIFT_REPORTS" });
    expect(gatedFeatureFor(`/organizations/${O}/me/shift-reports/${R}/submit`, "POST")).toMatchObject({ feature: "SHIFT_REPORTS" });
    expect(gatedFeatureFor(`/organizations/${O}/shift-reports/${R}/return`, "POST")).toMatchObject({ feature: "SHIFT_REPORTS" });
  });

  it("rollback aborts once caregivers reviewed anything", () => {
    expect(rollback).toMatch(/caregiver reviews exist: rollback aborted/);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '128_shift_reports_caregiver_review\.sql'/);
  });
});

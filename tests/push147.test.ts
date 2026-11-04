import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationTargetPath } from "../src/modules/push/pushTarget.js";

const A = "55555555-5555-4555-8555-555555555555";
const sql = readFileSync(new URL("../migrations/147_web_push_smartmatch_activities.sql", import.meta.url), "utf8");
const rows = [...sql.matchAll(/\('([A-Z_]+)',\s+'(agency|caregiver|family|self|applicant)',\s+'ETNARA Care',\s+'([^']+)',\s+(\d+),\s+'(normal|high)'\)/g)]
  .map(([, type, audience, body]) => ({ type, audience, body }));

describe("147 catalogue: SmartMatch, activities, end of visit", () => {
  it("adds the 10 approved entries", () => { expect(rows).toHaveLength(10); });
  it("keeps lock-screen text general", () => {
    for (const r of rows) {
      expect(r.body, r.type).not.toMatch(/[0-9{}<>@/$%]/);
      expect(r.body, r.type).not.toMatch(/residente|paciente|diagn|calle|avenida/i);
      expect(r.body.length, r.type).toBeLessThanOrEqual(80);
    }
  });
  it("activities go to the family only; end of visit to family and agency", () => {
    expect(rows.filter((r) => r.type === "NEW_CARE_EVENT").map((r) => r.audience)).toEqual(["family"]);
    expect(rows.filter((r) => r.type === "SHIFT_COMPLETED").map((r) => r.audience).sort()).toEqual(["agency", "family"]);
  });
  it("SmartMatch results go only to the applicant", () => {
    for (const r of rows.filter((x) => x.type.startsWith("SMARTMATCH_") && x.type !== "SMARTMATCH_APPLICATION_SUBMITTED")) expect(r.audience, r.type).toBe("applicant");
  });
  it("activities are throttled to one push every 30 min per resident", () => {
    expect(sql).toMatch(/notification_type = 'NEW_CARE_EVENT'[\s\S]*interval '30 minutes'[\s\S]*ACTIVITY_THROTTLED/);
  });
});

describe("147 where it opens", () => {
  const t = (type: string, audience: "agency" | "family" | "applicant", entity?: string) =>
    notificationTargetPath({ type, audience, relatedEntityType: entity ? "smartmatch_application" : null, relatedEntityId: entity ?? null, shiftId: null });
  it("SmartMatch", () => {
    expect(t("SMARTMATCH_APPLICATION_SUBMITTED", "agency", A)).toBe(`/agency/smartmatch?application=${A}`);
    expect(t("SMARTMATCH_APPLICATION_APPROVED", "applicant", A)).toBe(`/caregiver/smartmatch?tab=mine&application=${A}`);
    expect(t("SMARTMATCH_APPLICATION_APPROVED", "applicant", "x/../y")).toBe("/caregiver/smartmatch?tab=mine");
  });
  it("activities and end of visit", () => {
    expect(t("NEW_CARE_EVENT", "family")).toBe("/family/activity");
    expect(t("SHIFT_COMPLETED", "family")).toBe("/family");
    expect(t("SHIFT_COMPLETED", "agency")).toBe("/agency/shifts");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationTargetPath } from "../src/modules/push/pushTarget.js";

const sql = readFileSync(new URL("../migrations/155_smartmatch_new_opportunity_push.sql", import.meta.url), "utf8");
const rows = [...sql.matchAll(/\('([A-Z_]+)',\s+'(agency|caregiver|family|self|applicant)',\s+'ETNARA Care',\s+'([^']+)',\s+(\d+),\s+'(normal|high)'\)/g)]
  .map(([, type, audience, body]) => ({ type, audience, body }));

describe("155 SmartMatch «nueva oportunidad»", () => {
  it("adds one caregiver entry with a general lock-screen text", () => {
    expect(rows).toEqual([{ type: "SMARTMATCH_OPPORTUNITY_PUBLISHED", audience: "caregiver", body: "Hay una nueva oportunidad en SmartMatch" }]);
    expect(rows[0].body).not.toMatch(/[0-9{}<>@/$%]/);
  });
  it("notifies only active caregivers of the publishing agency, once, and only with SmartMatch on", () => {
    expect(sql).toMatch(/r\.code = 'WORKER'/);
    expect(sql).toMatch(/owm\.status = 'active'/);
    expect(sql).toMatch(/om\.organization_id = NEW\.organization_id/);
    expect(sql).toMatch(/app_org_feature_enabled\(NEW\.organization_id, 'SMARTMATCH'\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_smartmatch_published_once/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.app_smartmatch_opportunity_publish_notify\(\) FROM PUBLIC/);
  });
  it("limits bursts and drops pending pushes when the opportunity closes", () => {
    expect(sql).toMatch(/OPPORTUNITY_THROTTLED/);
    expect(sql).toMatch(/interval '30 minutes'/);
    expect(sql).toMatch(/OPPORTUNITY_CLOSED/);
  });
  it("opens the caregiver's SmartMatch list", () => {
    expect(notificationTargetPath({ type: "SMARTMATCH_OPPORTUNITY_PUBLISHED", audience: "caregiver", relatedEntityType: "smartmatch_opportunity",
      relatedEntityId: "55555555-5555-4555-8555-555555555555", shiftId: null })).toBe("/caregiver/smartmatch");
  });
});

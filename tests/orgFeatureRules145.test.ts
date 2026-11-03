import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const O = "11111111-1111-4111-8111-111111111111", X = "22222222-2222-4222-8222-222222222222";
describe("145 feature gate", () => {
  it("is case-insensitive like Express routing (other capitals never skip it)", () => {
    expect(gatedFeatureFor(`/organizations/${O}/Care-Recipients/${X}/photo-consents`)?.feature).toBe("ACTIVITY_PHOTOS");
    expect(gatedFeatureFor(`/ORGANIZATIONS/${O}/activity-photos`, "POST")?.feature).toBe("ACTIVITY_PHOTOS");
    expect(gatedFeatureFor(`/organizations/${O.toUpperCase()}/finance/x`)?.organizationId).toBe(O);
  });
  it("legal-review mode: only list, mode, history, image (GET) and legal-hold (POST) pass with the switch off", () => {
    expect(gatedFeatureFor(`/organizations/${O}/activity-photos`, "GET")?.readOnlyPass).toBe(true);
    expect(gatedFeatureFor(`/organizations/${O}/activity-photos/mode`, "GET")?.readOnlyPass).toBe(true);
    expect(gatedFeatureFor(`/organizations/${O}/activity-photos/${X}/image`, "GET")?.readOnlyPass).toBe(true);
    expect(gatedFeatureFor(`/organizations/${O}/activity-photos/${X}/history`, "GET")?.readOnlyPass).toBe(true);
    expect(gatedFeatureFor(`/organizations/${O}/activity-photos/${X}/legal-hold`, "POST")?.readOnlyPass).toBe(true);
    for (const [path, method] of [[`/activity-photos/${X}/hold`, "POST"], [`/activity-photos/${X}/delete`, "POST"], [`/activity-photos/${X}/review`, "POST"],
      [`/activity-photos/${X}/legal-hold`, "GET"], [`/care-events/${X}/photo`, "POST"], [`/care-recipients/${X}/photo-consents`, "GET"]]) {
      expect(gatedFeatureFor(`/organizations/${O}${path}`, method)?.readOnlyPass, `${method} ${path}`).toBeUndefined();
    }
  });
});

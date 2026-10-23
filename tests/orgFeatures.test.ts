import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const O = "11111111-2222-4333-8444-555555555555";
const S = "66666666-7777-4888-9999-000000000000";
const m108 = readFileSync(resolve(process.cwd(), "migrations/108_organization_features.sql"), "utf8").replace(/--[^\n]*/g, "");

describe("SmartMatch pilot switches (migration 108)", () => {
  it("gates SmartMatch, private instructions, «En camino» and «Llegué»", () => {
    expect(gatedFeatureFor(`/organizations/${O}/smartmatch/opportunities`)).toEqual({ organizationId: O, feature: "SMARTMATCH" });
    expect(gatedFeatureFor(`/organizations/${O}/smartmatch/available-opportunities`)?.feature).toBe("SMARTMATCH");
    expect(gatedFeatureFor(`/organizations/${O}/shifts/${S}/private-instructions`)?.feature).toBe("SMARTMATCH");
    expect(gatedFeatureFor(`/organizations/${O}/shifts/${S}/journey`)?.feature).toBe("EN_CAMINO");
    expect(gatedFeatureFor(`/organizations/${O}/shifts/${S}/journey/en-route`)?.feature).toBe("EN_CAMINO");
    expect(gatedFeatureFor(`/organizations/${O}/shifts/${S}/arrival/review`)?.feature).toBe("EN_CAMINO");
    expect(gatedFeatureFor(`/organizations/${O}/operations/journeys`)?.feature).toBe("EN_CAMINO");
    expect(gatedFeatureFor(`/organizations/${O}/me/location-consent`)?.feature).toBe("EN_CAMINO");
  });
  it("leaves core routes alone (Turnos, check-in/out, addresses, family)", () => {
    for (const p of [`/organizations/${O}/shifts`, `/organizations/${O}/shifts/${S}`, `/organizations/${O}/shifts/${S}/check-in`,
      `/organizations/${O}/shifts/${S}/check-out`, `/organizations/${O}/care-recipients/${S}/service-locations`,
      `/organizations/${O}/care-recipients/${S}/family-shifts`, "/me", `/organizations/${O}/smartmatchx`]) {
      expect(gatedFeatureFor(p)).toBeNull();
    }
  });
  it("defaults to off, platform-only writes, audited, with a database barrier and gated jobs", () => {
    expect(m108).toMatch(/enabled boolean NOT NULL DEFAULT false/);
    expect(m108).toMatch(/organization_features_platform_write[\s\S]*?WITH CHECK \(app_is_superadmin\(\)\)/);
    expect(m108).toContain("organization_feature_events_append_only");
    for (const t of ["smartmatch_opportunities", "smartmatch_applications", "shift_journey_events", "shift_arrivals"]) {
      expect(m108).toMatch(new RegExp(`BEFORE INSERT ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION app_require_org_feature`));
    }
    expect(m108.match(/app_org_feature_enabled\(s\.organization_id, 'EN_CAMINO'\)/g)?.length).toBe(2);
  });
});

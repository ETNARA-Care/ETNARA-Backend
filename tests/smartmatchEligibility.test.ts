import { describe, expect, it } from "vitest";
import { isSmartMatchEligible } from "../src/modules/smartmatch/smartmatch.eligibility.js";

const eligible = {
  optedIn: true,
  credentialEligible: true,
  scheduleAvailable: true,
  activeNetworkMembership: false,
  sameOrganization: true,
  visibility: "INTERNAL" as const,
  drivingMinutes: 25,
};

describe("SmartMatch eligibility", () => {
  it("allows an eligible internal match at 25 minutes", () => {
    expect(isSmartMatchEligible(eligible)).toBe(true);
  });
  it("denies other organizations' internal listings", () => {
    expect(isSmartMatchEligible({ ...eligible, sameOrganization: false })).toBe(false);
  });
  it("requires network membership for cross-organization matches", () => {
    expect(isSmartMatchEligible({
      ...eligible, visibility: "NETWORK", sameOrganization: false,
    })).toBe(false);
    expect(isSmartMatchEligible({
      ...eligible, visibility: "NETWORK", sameOrganization: false,
      activeNetworkMembership: true,
    })).toBe(true);
  });
  it("rejects unknown or excessive travel time", () => {
    expect(isSmartMatchEligible({ ...eligible, drivingMinutes: null })).toBe(false);
    expect(isSmartMatchEligible({ ...eligible, drivingMinutes: 26 })).toBe(false);
  });
  it("rejects missing consent, credentials or availability", () => {
    expect(isSmartMatchEligible({ ...eligible, optedIn: false })).toBe(false);
    expect(isSmartMatchEligible({ ...eligible, credentialEligible: false })).toBe(false);
    expect(isSmartMatchEligible({ ...eligible, scheduleAvailable: false })).toBe(false);
  });
});

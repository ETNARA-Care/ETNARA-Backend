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
  it("rejects non-finite, fractional, negative and excessive travel estimates", () => {
    for (const drivingMinutes of [NaN, Infinity, -1, 24.5, 26]) {
      expect(isSmartMatchEligible({ ...eligible, drivingMinutes })).toBe(false);
    }
    expect(isSmartMatchEligible({ ...eligible, drivingMinutes: 0 })).toBe(true);
  });

  it("never lets network membership override caregiver consent or credentials", () => {
    const network = {
      ...eligible,
      visibility: "NETWORK" as const,
      sameOrganization: false,
      activeNetworkMembership: true,
    };
    expect(isSmartMatchEligible({ ...network, optedIn: false })).toBe(false);
    expect(isSmartMatchEligible({ ...network, credentialEligible: false })).toBe(false);
    expect(isSmartMatchEligible({ ...network, scheduleAvailable: false })).toBe(false);
  });

});

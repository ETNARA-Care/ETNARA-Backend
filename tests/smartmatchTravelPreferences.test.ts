import { describe, expect, it } from "vitest";
import { isSmartMatchEligible } from "../src/modules/smartmatch/smartmatch.eligibility.js";

const base = {
  optedIn: true,
  credentialEligible: true,
  scheduleAvailable: true,
  activeNetworkMembership: false,
  sameOrganization: true,
  visibility: "INTERNAL" as const,
  drivingMinutes: 30,
};

describe("caregiver travel-time preference", () => {
  it("uses 25 minutes by default", () => {
    expect(isSmartMatchEligible(base)).toBe(false);
  });
  it("accepts a caregiver-selected 30 minute limit", () => {
    expect(isSmartMatchEligible({ ...base, maxDrivingMinutes: 30 })).toBe(true);
  });
  it("rejects limits outside 10 to 60 minutes", () => {
    for (const limit of [0, 9, 61, 20.5, NaN, Infinity]) {
      expect(isSmartMatchEligible({ ...base, maxDrivingMinutes: limit })).toBe(false);
    }
  });
  it("never bypasses consent, credentials or organization boundaries", () => {
    expect(isSmartMatchEligible({ ...base, maxDrivingMinutes: 60, optedIn: false })).toBe(false);
    expect(isSmartMatchEligible({ ...base, maxDrivingMinutes: 60, credentialEligible: false })).toBe(false);
    expect(isSmartMatchEligible({ ...base, maxDrivingMinutes: 60, sameOrganization: false })).toBe(false);
  });
});

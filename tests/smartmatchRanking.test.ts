import { describe, expect, it } from "vitest";
import { rankSmartMatchCandidates } from "../src/modules/smartmatch/smartmatch.ranking.js";
import type { SmartMatchEligibility } from "../src/modules/smartmatch/smartmatch.eligibility.js";

const allowed: SmartMatchEligibility = {
  optedIn: true,
  credentialEligible: true,
  scheduleAvailable: true,
  activeNetworkMembership: false,
  sameOrganization: true,
  visibility: "INTERNAL",
  drivingMinutes: 15,
};

describe("SmartMatch candidate ordering", () => {
  it("ranks eligible candidates by verified driving minutes and stable opaque id", () => {
    const input = [
      { opaqueCandidateId: "b", eligibility: { ...allowed, drivingMinutes: 15 } },
      { opaqueCandidateId: "c", eligibility: { ...allowed, drivingMinutes: 9 } },
      { opaqueCandidateId: "a", eligibility: { ...allowed, drivingMinutes: 15 } },
    ];
    expect(rankSmartMatchCandidates(input)).toEqual([
      { opaqueCandidateId: "c", estimatedDriveMinutes: 9 },
      { opaqueCandidateId: "a", estimatedDriveMinutes: 15 },
      { opaqueCandidateId: "b", estimatedDriveMinutes: 15 },
    ]);
    expect(input[0].opaqueCandidateId).toBe("b");
  });

  it("excludes unverified credentials, no consent, conflicts, and unknown or distant routes", () => {
    const input = [
      { opaqueCandidateId: "no-consent", eligibility: { ...allowed, optedIn: false } },
      { opaqueCandidateId: "no-credential", eligibility: { ...allowed, credentialEligible: false } },
      { opaqueCandidateId: "busy", eligibility: { ...allowed, scheduleAvailable: false } },
      { opaqueCandidateId: "unknown", eligibility: { ...allowed, drivingMinutes: null } },
      { opaqueCandidateId: "distant", eligibility: { ...allowed, drivingMinutes: 26 } },
      { opaqueCandidateId: "other-agency", eligibility: { ...allowed, sameOrganization: false } },
      { opaqueCandidateId: "eligible", eligibility: allowed },
    ];
    expect(rankSmartMatchCandidates(input)).toEqual([
      { opaqueCandidateId: "eligible", estimatedDriveMinutes: 15 },
    ]);
  });

  it("does not allow network membership to bypass consent", () => {
    expect(rankSmartMatchCandidates([{
      opaqueCandidateId: "network",
      eligibility: {
        ...allowed, visibility: "NETWORK", sameOrganization: false,
        activeNetworkMembership: true, optedIn: false,
      },
    }])).toEqual([]);
  });
});

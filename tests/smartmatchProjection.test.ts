import { describe, expect, it } from "vitest";
import { projectSmartMatchOpportunity } from "../src/modules/smartmatch/smartmatch.projection.js";

const candidate = {
  id: "11111111-1111-4111-8111-111111111111",
  regionLabel: "Carolina",
  startsAt: "2026-11-01T12:00:00Z",
  endsAt: "2026-11-01T20:00:00Z",
  roleLabel: "Caregiver",
  estimatedDriveMinutes: 25,
};

describe("SmartMatch discovery projection", () => {
  it("only returns public opportunity fields", () => {
    const result = projectSmartMatchOpportunity({
      ...candidate,
      patientName: "Private",
      exactAddress: "Private",
      organizationId: "secret",
    } as typeof candidate);
    expect(result).toEqual(candidate);
  });

  it("fails closed for unknown routes and travel times above 25", () => {
    expect(projectSmartMatchOpportunity({ ...candidate, estimatedDriveMinutes: null })).toBeNull();
    expect(projectSmartMatchOpportunity({ ...candidate, estimatedDriveMinutes: 26 })).toBeNull();
  });
});

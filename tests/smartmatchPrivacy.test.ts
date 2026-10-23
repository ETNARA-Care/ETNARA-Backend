import { describe, expect, it } from "vitest";
import {
  smartMatchLocationPreferenceSchema,
  smartMatchOpportunitySummarySchema,
  smartMatchPublishSchema,
} from "../src/modules/smartmatch/smartmatch.schemas.js";

const base = {
  visibility: "INTERNAL" as const,
  startsAt: "2026-11-01T12:00:00Z",
  endsAt: "2026-11-01T20:00:00Z",
  roleLabel: "Caregiver",
  regionLabel: "Carolina",
};
const summary = {
  id: "11111111-1111-4111-8111-111111111111",
  regionLabel: "Carolina",
  startsAt: base.startsAt,
  endsAt: base.endsAt,
  roleLabel: "Caregiver",
  estimatedDriveMinutes: 25,
};

describe("SmartMatch privacy and limits", () => {
  it("accepts network publications", () => {
    expect(smartMatchPublishSchema.safeParse({ ...base, visibility: "NETWORK" }).success).toBe(true);
  });
  it("rejects reversed shift dates", () => {
    expect(smartMatchPublishSchema.safeParse({ ...base, startsAt: base.endsAt }).success).toBe(false);
  });
  it("rejects extra identifying fields in opportunity summaries", () => {
    expect(smartMatchOpportunitySummarySchema.safeParse({ ...summary, patientName: "Private" }).success).toBe(false);
  });
  it("accepts the 25 minute boundary but not 26", () => {
    expect(smartMatchOpportunitySummarySchema.safeParse(summary).success).toBe(true);
    expect(smartMatchOpportunitySummarySchema.safeParse({ ...summary, estimatedDriveMinutes: 26 }).success).toBe(false);
  });
  it("requires affirmative location consent", () => {
    expect(smartMatchLocationPreferenceSchema.safeParse({
      consent: false, locationReference: "reference", notificationsEnabled: true,
    }).success).toBe(false);
    expect(smartMatchLocationPreferenceSchema.safeParse({
      consent: true, locationReference: "reference", notificationsEnabled: true,
    }).success).toBe(true);
  });
});

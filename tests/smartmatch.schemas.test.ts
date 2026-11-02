import { describe, expect, it } from 'vitest';
import {
  smartMatchPublishSchema,
  smartMatchLocationPreferenceSchema,
  smartMatchOpportunitySummarySchema,
} from '../src/modules/smartmatch/smartmatch.schemas.js';

// Fixed dates went stale on 2-nov-2026 (publications must be in the future): one week from today at 12:00–20:00 UTC.
const futureDay = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmmss: string) => `${futureDay}T${hhmmss}Z`;
const validOpportunity = {
  visibility: 'INTERNAL',
  startsAt: at("12:00:00"),
  endsAt: at("20:00:00"),
  roleLabel: 'Caregiver',
  regionLabel: 'Carolina',
};

describe('SmartMatch publication input guardrails', () => {
  it('accepts valid service hours', () => {
    expect(smartMatchPublishSchema.safeParse(validOpportunity).success).toBe(true);
  });

  it('rejects an end before or equal to the start', () => {
    expect(smartMatchPublishSchema.safeParse({
      ...validOpportunity, endsAt: at("11:59:59"),
    }).success).toBe(false);
    expect(smartMatchPublishSchema.safeParse({
      ...validOpportunity, endsAt: validOpportunity.startsAt,
    }).success).toBe(false);
  });

  it('rejects clinical details, patient identifiers and exact addresses', () => {
    for (const forbiddenField of ['patientName', 'patientId', 'diagnosis', 'exactAddress']) {
      expect(smartMatchPublishSchema.safeParse({
        ...validOpportunity, [forbiddenField]: 'PRIVATE',
      }).success).toBe(false);
    }
  });

  it('rejects invalid time formats and overlong public labels', () => {
    expect(smartMatchPublishSchema.safeParse({
      ...validOpportunity, startsAt: 'tomorrow',
    }).success).toBe(false);
    expect(smartMatchPublishSchema.safeParse({
      ...validOpportunity, regionLabel: 'X'.repeat(101),
    }).success).toBe(false);
  });

  it('requires explicit caregiver location consent and rejects extra tracking fields', () => {
    const preference = {
      consent: true,
      locationReference: 'Carolina',
      notificationsEnabled: true,
    };
    expect(smartMatchLocationPreferenceSchema.safeParse(preference).success).toBe(true);
    expect(smartMatchLocationPreferenceSchema.safeParse({
      ...preference, consent: false,
    }).success).toBe(false);
    expect(smartMatchLocationPreferenceSchema.safeParse({
      ...preference, liveCoordinates: [18.4, -66.1],
    }).success).toBe(false);
  });

  it('rejects private fields and out-of-range driving time in public summaries', () => {
    const summary = {
      id: 'b718bf35-8fa4-45e5-b67c-4cc4e50dff32',
      regionLabel: 'Carolina',
      roleLabel: 'Caregiver',
      startsAt: validOpportunity.startsAt,
      endsAt: validOpportunity.endsAt,
      estimatedDriveMinutes: 25,
    };
    expect(smartMatchOpportunitySummarySchema.safeParse(summary).success).toBe(true);
    expect(smartMatchOpportunitySummarySchema.safeParse({
      ...summary, estimatedDriveMinutes: 26,
    }).success).toBe(false);
    expect(smartMatchOpportunitySummarySchema.safeParse({
      ...summary, residentName: 'PRIVATE',
    }).success).toBe(false);
  });
});

import { z } from "zod";

/** Sanitized data only: never include patient identifiers or exact service addresses. */
export const smartMatchVisibilitySchema = z.enum(["INTERNAL", "NETWORK"]);
export const smartMatchOpportunitySummarySchema = z.object({
  id: z.string().uuid(),
  regionLabel: z.string().trim().min(1).max(100),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  roleLabel: z.string().trim().min(1).max(100),
  estimatedDriveMinutes: z.number().int().min(0).max(25),
}).strict();

export const smartMatchPublishSchema = z.object({
  visibility: smartMatchVisibilitySchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  roleLabel: z.string().trim().min(1).max(100),
  regionLabel: z.string().trim().min(1).max(100),
}).strict().refine(v => Date.parse(v.startsAt) < Date.parse(v.endsAt), {
  message: "Service end must follow start",
});

export const smartMatchLocationPreferenceSchema = z.object({
  consent: z.literal(true),
  locationReference: z.string().trim().min(1).max(200),
  notificationsEnabled: z.boolean(),
}).strict();

export const smartMatchApplicationSchema = z.object({
  opportunityId: z.string().uuid(),
}).strict();

export type SmartMatchPublishInput = z.infer<typeof smartMatchPublishSchema>;

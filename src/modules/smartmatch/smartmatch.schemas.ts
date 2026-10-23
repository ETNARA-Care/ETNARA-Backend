import { z } from "zod";
import { isPuertoRicoMunicipality, isSafeRoleLabel } from "./smartmatch.privacy.js";

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
  // Gate 5: a job title only (predefined or safe free text) and one of the
  // 78 municipalities -- never a name, phone number or address.
  roleLabel: z.string().trim().min(1).max(60).refine(isSafeRoleLabel, { message: "ROLE_LABEL_NOT_ALLOWED" }),
  regionLabel: z.string().trim().min(1).max(100).refine(isPuertoRicoMunicipality, { message: "REGION_NOT_A_MUNICIPALITY" }),
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

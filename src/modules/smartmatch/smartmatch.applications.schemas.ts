import { z } from "zod";

/**
 * Current consent text version. The caregiver UI shows the matching text and
 * must send this exact version; changing the text requires a new version.
 */
export const SMARTMATCH_CONSENT_VERSION = "smartmatch-consent-v1";

export const smartMatchApplySchema = z.object({
  consent: z.literal(true),
  consentVersion: z.literal(SMARTMATCH_CONSENT_VERSION),
}).strict();
export const smartMatchDecisionSchema = z.discriminatedUnion("decision", [
  // Approval requires an explicit confirmation flag from the reviewing admin.
  z.object({ decision: z.literal("APPROVE"), confirm: z.literal(true) }).strict(),
  z.object({ decision: z.literal("REJECT") }).strict(),
]);

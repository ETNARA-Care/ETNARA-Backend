import { z } from "zod";

/** 176 · Hogares F3 (asignación de residentes y sustitución administrativa): entradas de las rutas, sin base de datos. */
const isoInstant = z.string().datetime({ offset: true });
const ids = z.array(z.string().uuid()).min(1).max(100);
export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Motivos de la sustitución: categorías operativas. Nunca se piden datos de salud (D7). */
export const SUBSTITUTION_REASONS = ["unplanned_absence", "operational", "schedule_change", "other"] as const;

export const assignResidentsSchema = z.object({
  membershipId: z.string().uuid(),
  careRecipientIds: ids,
  effectiveAt: isoInstant.optional(),
}).strict();

export const redistributeSchema = z.object({
  moves: z.array(z.object({
    careRecipientId: z.string().uuid(),
    fromMembershipId: z.string().uuid(),
    toMembershipId: z.string().uuid().nullable(),
  }).strict()).min(1).max(100),
  effectiveAt: isoInstant.optional(),
  confirmUncovered: z.boolean().default(false),
  uncoveredReason: z.string().trim().min(3).max(300).optional(),
}).strict().refine((v) => v.moves.every((m) => m.fromMembershipId !== m.toMembershipId), { message: "same" });

export const substitutionSchema = z.object({
  originalMembershipId: z.string().uuid(),
  substituteMembershipId: z.string().uuid(),
  effectiveAt: isoInstant.optional(),
  reasonCode: z.enum(SUBSTITUTION_REASONS),
  reasonNote: z.string().trim().max(300).optional(),
  confirmAvailability: z.boolean().default(false),
  transfers: z.array(z.object({ careRecipientId: z.string().uuid(), toMembershipId: z.string().uuid() }).strict()).max(100).default([]),
  confirmUncovered: z.boolean().default(false),
  uncoveredReason: z.string().trim().min(3).max(300).optional(),
}).strict().refine((v) => v.originalMembershipId !== v.substituteMembershipId, { message: "same" });

export const substitutionPreviewSchema = z.object({
  originalMembershipId: z.string().uuid(),
  substituteMembershipId: z.string().uuid(),
  effectiveAt: isoInstant.optional(),
}).strict();

export const resolveAlertSchema = z.object({}).strict();

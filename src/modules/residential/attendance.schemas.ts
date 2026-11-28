import { z } from "zod";

/** 173–175 · Hogares F4 (ponches): entradas de las rutas, sin dependencias de base de datos. */
export const PUNCH_TYPES = ["in", "out", "break_start", "break_end", "meal_start", "meal_end"] as const;
const reason = z.string().trim().min(3).max(300);
const isoInstant = z.string().datetime({ offset: true });
export const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;
/** Versión del aviso de geolocalización laboral vigente (texto pendiente de validación jurídica, §13 del plan). */
export const GEO_CONSENT_VERSION = "geo-1";

export const punchSchema = z.object({
  clientEventId: z.string().uuid(),
  shiftId: z.string().uuid(),
  type: z.enum(PUNCH_TYPES),
  method: z.enum(["qr", "pin"]),
  qr: z.string().max(200).optional(),
  pin: z.string().regex(/^\d{6}$/).optional(),
  offline: z.boolean().default(false),
  declaredAt: isoInstant.optional(),
  deviceNow: isoInstant.optional(),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000),
  }).strict().optional(),
}).strict()
  .refine((v) => (v.method === "qr" ? !!v.qr && !v.pin : !!v.pin && !v.qr), { message: "code" })
  .refine((v) => !v.offline || !!v.declaredAt, { message: "declaredAt" });

export const consentSchema = z.object({ version: z.literal(GEO_CONSENT_VERSION), accept: z.boolean() }).strict();

export const correctionSchema = z.object({
  shiftId: z.string().uuid(),
  punchId: z.string().uuid().optional(),
  type: z.enum(PUNCH_TYPES),
  requestedAt: isoInstant,
  reason,
}).strict();

export const reviewSchema = z.object({
  punchIds: z.array(z.string().uuid()).min(1).max(200),
  decision: z.enum(["validated", "justified", "not_recognized"]),
  reason,
}).strict();

export const manualPunchSchema = z.object({
  shiftId: z.string().uuid(),
  membershipId: z.string().uuid(),
  type: z.enum(PUNCH_TYPES),
  at: isoInstant,
  reason,
}).strict();

export const decideCorrectionSchema = z.object({ approve: z.boolean(), reason }).strict();
export const revokeSchema = z.object({ weekStart: z.string().regex(WEEK_START), reason }).strict();
export const printSchema = z.object({ weekStart: z.string().regex(WEEK_START) }).strict();
export const policySchema = z.object({
  transitionHours: z.number().int().min(0).max(12),
  lateToleranceMinutes: z.number().int().min(0).max(120),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(120),
  absenceAfterMinutes: z.number().int().min(15).max(720),
  reason,
}).strict();
export const listPunchesSchema = z.object({
  locationId: z.string().uuid().optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  status: z.enum(["validated", "pending_review", "justified", "not_recognized"]).optional(),
}).strict();

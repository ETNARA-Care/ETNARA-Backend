import { z } from "zod";

/** 172 · Hogares F2 (calendario semanal): entradas de las rutas, sin dependencias de base de datos. */
export const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;
/** Fecha y hora LOCAL de Puerto Rico (sin zona): «2026-12-07T23:00». */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const role = z.string().trim().min(1).max(80);
const label = z.string().trim().max(40).nullable().optional();
const duration = z.number().int().min(15).max(1440);

export const createEntrySchema = z.object({
  startsAt: localDateTime,
  durationMinutes: duration,
  requiredRole: role.optional(),
  membershipId: z.string().uuid().nullable().optional(),
  label,
}).strict();
export const updateEntrySchema = z.object({
  startsAt: localDateTime.optional(),
  durationMinutes: duration.optional(),
  requiredRole: role.optional(),
  membershipId: z.string().uuid().nullable().optional(),
  label,
}).strict().refine((v) => Object.keys(v).length > 0);
export const copyWeekSchema = z.object({ fromWeekStart: z.string().regex(WEEK_START) }).strict();
export const applyTemplateSchema = z.object({ templateId: z.string().uuid() }).strict();

const slot = z.object({
  weekday: z.number().int().min(1).max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: duration,
  requiredRole: role.optional(),
  headcount: z.number().int().min(1).max(20).optional(),
  label,
}).strict();
export const createTemplateSchema = z.object({ name: z.string().trim().min(1).max(80), slots: z.array(slot).min(1).max(100) }).strict();
export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slots: z.array(slot).min(1).max(100).optional(),
  archived: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0);

/** Lunes de una semana ISO (la fecha recibida debe serlo). */
export function isMonday(date: string): boolean {
  if (!WEEK_START.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() === 1;
}

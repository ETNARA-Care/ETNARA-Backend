import { z } from "zod";

/** Límite técnico del tipo integer de PostgreSQL (evita un error de desbordamiento). No es un tope de camas. */
const PG_INT_MAX = 2147483647;

/** 171 · Entradas de las rutas de hogares F1 (sin dependencias de base de datos, para poder probarlas solas). */
const name = z.string().trim().min(1).max(80).refine((v) => !v.toLowerCase().startsWith("__etnara"), "RESERVED_NAME");
const reason = z.string().trim().min(3).max(500);
export const createUnitSchema = z.object({ name }).strict();
export const updateUnitSchema = z.object({ name: name.optional(), archived: z.boolean().optional() }).strict()
  .refine((v) => v.name !== undefined || v.archived !== undefined);
export const createRoomSchema = z.object({ name, unitId: z.string().uuid().optional(), bedCapacity: z.number().int().min(1).max(PG_INT_MAX).nullable().optional() }).strict();
export const updateRoomSchema = z.object({
  name: name.optional(), unitId: z.string().uuid().optional(), archived: z.boolean().optional(),
  bedCapacity: z.number().int().min(1).max(PG_INT_MAX).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0);
export const placementSchema = z.object({
  roomId: z.string().uuid().nullable(),
  establishmentId: z.string().uuid().optional(),
  reason: reason.optional(),
}).strict();
export const geofenceSchema = z.object({
  radiusMeters: z.number().int().min(50).max(300),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  reason,
}).strict().refine((v) => (v.latitude === undefined) === (v.longitude === undefined) && ((v.latitude ?? null) === null) === ((v.longitude ?? null) === null), "CENTER_PAIR");
export const closeSchema = z.object({ reason }).strict();

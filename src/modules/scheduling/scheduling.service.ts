import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";
import { WorkerNotLinkedError } from "../verification/verification.service.js";
export { WorkerNotLinkedError };

export class ShiftNotFoundError extends Error {
  constructor() {
    super("SHIFT_NOT_FOUND");
    this.name = "ShiftNotFoundError";
  }
}
export class InvalidShiftTimesError extends Error {
  constructor() {
    super("INVALID_SHIFT_TIMES");
    this.name = "InvalidShiftTimesError";
  }
}
export class RecipientNotInOrgError extends Error {
  constructor() {
    super("RECIPIENT_NOT_IN_ORGANIZATION");
    this.name = "RecipientNotInOrgError";
  }
}
export class RoomNotInOrgError extends Error {
  constructor() {
    super("ROOM_NOT_IN_ORGANIZATION");
    this.name = "RoomNotInOrgError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

// Whitelist -- organization_id is NEVER read from the body, for create or
// update, matching the same pattern used for care_recipients. A shift must
// target a recipient (home care) or a room (residential) -- schema's own
// CHECK constraint requires at least one; we validate the same rule here
// before touching SQL, for a clean 400 instead of a raw constraint error.
export const createShiftSchema = z
  .object({
    careRecipientId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
  })
  .refine((d) => d.careRecipientId || d.roomId, {
    message: "Either careRecipientId (home care) or roomId (residential) is required",
  })
  .refine((d) => new Date(d.scheduledStart).getTime() < new Date(d.scheduledEnd).getTime(), {
    message: "scheduledStart must be strictly before scheduledEnd",
  });
export type CreateShiftInput = z.infer<typeof createShiftSchema>;

const updateShiftSchema = z
  .object({
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    status: z.enum(["unassigned", "confirmed", "in_progress", "completed"]), // 'cancelled' only via the dedicated cancel action
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field required" });
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export { updateShiftSchema };

interface ShiftRow {
  id: string;
  organization_id: string;
  care_recipient_id: string | null;
  room_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function createShift(
  userId: string,
  organizationId: string,
  input: CreateShiftInput
): Promise<ShiftRow> {
  // Defense in depth: never trust that the route layer's Zod refine was
  // the only thing standing between an invalid time range and the
  // database -- re-check here too, exactly like every other check in this
  // function, so calling this service directly (bypassing the route) can
  // never create start >= end.
  if (new Date(input.scheduledStart).getTime() >= new Date(input.scheduledEnd).getTime()) {
    throw new InvalidShiftTimesError();
  }
  return withTenantContext({ userId, organizationId }, async (trx) => {
    if (input.careRecipientId) {
      const check = await sql<{ id: string }>`
        SELECT id FROM care_recipients WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId} LIMIT 1
      `.execute(trx);
      if (!check.rows[0]) throw new RecipientNotInOrgError();
    }
    if (input.roomId) {
      const check = await sql<{ id: string }>`
        SELECT id FROM rooms WHERE id = ${input.roomId} AND organization_id = ${organizationId} LIMIT 1
      `.execute(trx);
      if (!check.rows[0]) throw new RoomNotInOrgError();
    }

    const result = await sql<ShiftRow>`
      INSERT INTO shifts (organization_id, care_recipient_id, room_id, scheduled_start, scheduled_end)
      VALUES (${organizationId}, ${input.careRecipientId ?? null}, ${input.roomId ?? null}, ${input.scheduledStart}, ${input.scheduledEnd})
      RETURNING id, organization_id, care_recipient_id, room_id, scheduled_start, scheduled_end, status, created_at, updated_at
    `.execute(trx);
    return result.rows[0];
  });
}

export interface ListShiftsFilter {
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  careRecipientId?: string;
  coverage?: "covered" | "uncovered";
}

export async function listShifts(userId: string, organizationId: string, filter: ListShiftsFilter = {}) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const conditions = [sql`s.organization_id = ${organizationId}`];
    if (filter.dateFrom) conditions.push(sql`s.scheduled_start >= ${filter.dateFrom}`);
    if (filter.dateTo) conditions.push(sql`s.scheduled_start <= ${filter.dateTo}`);
    if (filter.status) conditions.push(sql`s.status = ${filter.status}`);
    if (filter.careRecipientId) conditions.push(sql`s.care_recipient_id = ${filter.careRecipientId}`);

    const whereClause = sql.join(conditions, sql` AND `);

    // Coverage is derived, never a client-supplied boolean: a shift is
    // "covered" if it has at least one row in assignments, "uncovered" if
    // it has none. Cancelled shifts are excluded from the uncovered set --
    // there's nothing left to cover.
    let havingClause = sql``;
    if (filter.coverage === "uncovered") {
      havingClause = sql`HAVING count(a.id) = 0 AND s.status != 'cancelled'`;
    } else if (filter.coverage === "covered") {
      havingClause = sql`HAVING count(a.id) > 0`;
    }

    const result = await sql<ShiftRow & { assignment_count: number }>`
      SELECT s.id, s.organization_id, s.care_recipient_id, s.room_id, s.scheduled_start, s.scheduled_end,
             s.status, s.created_at, s.updated_at, count(a.id)::int as assignment_count
      FROM shifts s
      LEFT JOIN assignments a ON a.shift_id = s.id
      WHERE ${whereClause}
      GROUP BY s.id
      ${havingClause}
      ORDER BY s.scheduled_start
    `.execute(trx);
    return result.rows;
  });
}

/**
 * "Mis turnos" para el worker autenticado -- resuelve el worker desde el
 * userId del token (NUNCA aceptado del cliente), igual que ya hace
 * verification.service.ts para check-in/check-out. Un solo JOIN, sin
 * N+1: solo devuelve shifts que tienen una assignment activa para ESE
 * worker en ESA organización. No modifica ni depende de ningún cambio a
 * la RLS de `shifts` -- es una consulta más restrictiva por encima de
 * ella, tal como ya hacía listShifts con sus propios filtros.
 */
export async function listMyShifts(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerRow = await sql<{ id: string }>`
      SELECT id FROM workers WHERE user_id = ${userId} LIMIT 1
    `.execute(trx);
    const workerId = workerRow.rows[0]?.id;
    if (!workerId) throw new WorkerNotLinkedError();

    const result = await sql<ShiftRow>`
      SELECT s.id, s.organization_id, s.care_recipient_id, s.room_id, s.scheduled_start, s.scheduled_end,
             s.status, s.created_at, s.updated_at
      FROM shifts s
      JOIN assignments a
        ON a.shift_id = s.id
      JOIN organization_worker_memberships owm
        ON owm.id = a.organization_worker_membership_id
       AND owm.status = 'active'
      WHERE s.organization_id = ${organizationId}
        AND owm.worker_id = ${workerId}
      ORDER BY s.scheduled_start
    `.execute(trx);
    return result.rows;
  });
}

export async function getShift(userId: string, organizationId: string, shiftId: string) {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<ShiftRow>`
      SELECT id, organization_id, care_recipient_id, room_id, scheduled_start, scheduled_end, status, created_at, updated_at
      FROM shifts
      WHERE id = ${shiftId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new ShiftNotFoundError();
    return result.rows[0];
  });
}

export async function updateShift(
  userId: string,
  organizationId: string,
  shiftId: string,
  input: UpdateShiftInput
): Promise<ShiftRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    if (input.scheduledStart !== undefined && input.scheduledEnd !== undefined) {
      if (new Date(input.scheduledStart).getTime() >= new Date(input.scheduledEnd).getTime()) {
        throw new InvalidShiftTimesError();
      }
    } else if (input.scheduledStart !== undefined || input.scheduledEnd !== undefined) {
      // Need the other bound from DB to validate consistently.
      const current = await sql<{ scheduled_start: string; scheduled_end: string }>`
        SELECT scheduled_start, scheduled_end FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
      `.execute(trx);
      if (!current.rows[0]) throw new ShiftNotFoundError();
      const newStart = input.scheduledStart ? new Date(input.scheduledStart) : new Date(current.rows[0].scheduled_start);
      const newEnd = input.scheduledEnd ? new Date(input.scheduledEnd) : new Date(current.rows[0].scheduled_end);
      if (newStart.getTime() >= newEnd.getTime()) throw new InvalidShiftTimesError();
    }

    const fragments = [];
    if (input.scheduledStart !== undefined) fragments.push(sql`scheduled_start = ${input.scheduledStart}`);
    if (input.scheduledEnd !== undefined) fragments.push(sql`scheduled_end = ${input.scheduledEnd}`);
    if (input.status !== undefined) fragments.push(sql`status = ${input.status}`);
    fragments.push(sql`updated_at = now()`);

    const result = await sql<ShiftRow>`
      UPDATE shifts
      SET ${sql.join(fragments, sql`, `)}
      WHERE id = ${shiftId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, care_recipient_id, room_id, scheduled_start, scheduled_end, status, created_at, updated_at
    `.execute(trx);
    if (!result.rows[0]) throw new ShiftNotFoundError();
    return result.rows[0];
  });
}

/**
 * Cancellation: sets status='cancelled'. Never deletes the row, never
 * deletes its assignments or assignment_history -- those remain exactly as
 * they were, preserving history. New assignments against a cancelled shift
 * are rejected at the assignment layer (see assignments.service.ts).
 */
export async function cancelShift(userId: string, organizationId: string, shiftId: string): Promise<ShiftRow> {
  return updateShift(userId, organizationId, shiftId, { status: "cancelled" as never });
}

export interface CoverageSummary {
  total: number;
  covered: number;
  uncovered: number;
  cancelled: number;
}

export async function getCoverageSummary(userId: string, organizationId: string): Promise<CoverageSummary> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{ total: number; covered: number; uncovered: number; cancelled: number }>`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE assignment_count > 0)::int AS covered,
        count(*) FILTER (WHERE assignment_count = 0 AND status != 'cancelled')::int AS uncovered,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM (
        SELECT s.id, s.status, count(a.id) as assignment_count
        FROM shifts s
        LEFT JOIN assignments a ON a.shift_id = s.id
        WHERE s.organization_id = ${organizationId}
        GROUP BY s.id
      ) sub
    `.execute(trx);
    return result.rows[0];
  });
}

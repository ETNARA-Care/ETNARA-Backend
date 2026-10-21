import { sql, type RawBuilder } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

const recipientIdSchema = z.string().uuid();
function assertValidRecipientId(recipientId: string): void {
  if (!recipientIdSchema.safeParse(recipientId).success) {
    throw new InvalidTenantContextError(
      `recipientId must be a valid UUID, received: ${JSON.stringify(recipientId)}`
    );
  }
}

export class RecipientNotFoundError extends Error {
  constructor() {
    super("RECIPIENT_NOT_FOUND");
    this.name = "RecipientNotFoundError";
  }
}

// Explicit whitelist -- organization_id is deliberately NEVER part of this
// schema, for either create or update. A client cannot move a recipient
// between tenants by including organization_id in the body, because the
// field is never read from the body at all; it always comes from the
// authenticated route context (organizationId path param + validated
// membership), never from client-supplied data.
export const createRecipientSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  preferredName: z.string().optional(),
  dateOfBirth: z.string().date().optional(), // 'YYYY-MM-DD'
  allergies: z.array(z.string()).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  routines: z.record(z.string(), z.unknown()).optional(),
  roomId: z.string().uuid().optional(),
});

export const updateRecipientSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    preferredName: z.string().nullable(),
    dateOfBirth: z.string().date().nullable(),
    allergies: z.array(z.string()).nullable(),
    preferences: z.record(z.string(), z.unknown()).nullable(),
    routines: z.record(z.string(), z.unknown()).nullable(),
    roomId: z.string().uuid().nullable(),
    status: z.enum(["active", "archived"]),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field required" });

export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

interface RecipientRow {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  allergies: string[] | null;
  preferences: unknown;
  routines: unknown;
  status: string;
  room_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export async function createCareRecipient(
  userId: string,
  organizationId: string,
  input: CreateRecipientInput
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<RecipientRow>`
      INSERT INTO care_recipients (
        organization_id, first_name, last_name, preferred_name, date_of_birth,
        allergies, preferences, routines, room_id
      ) VALUES (
        ${organizationId}, ${input.firstName}, ${input.lastName}, ${input.preferredName ?? null},
        ${input.dateOfBirth ?? null}, ${input.allergies ?? null},
        ${input.preferences ? JSON.stringify(input.preferences) : null},
        ${input.routines ? JSON.stringify(input.routines) : null},
        ${input.roomId ?? null}
      )
      RETURNING id, organization_id, first_name, last_name, preferred_name, date_of_birth,
                allergies, preferences, routines, status, room_id, created_at, updated_at, archived_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listCareRecipients(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // No role branching in application code: RLS itself returns the right
    // set -- staff see every recipient in the org (minus FAMILY-only
    // members), a FAMILY-only member sees only recipients they have an
    // active family_relationship with. Same query, different rows,
    // entirely enforced by the two OR'd policies on care_recipients.
    const result = await sql<RecipientRow>`
      SELECT id, organization_id, first_name, last_name, preferred_name, date_of_birth,
             allergies, preferences, routines, status, room_id, created_at, updated_at, archived_at
      FROM care_recipients
      WHERE organization_id = ${organizationId}
      ORDER BY last_name, first_name
    `.execute(trx);
    return result.rows;
  });
}

export async function getCareRecipient(userId: string, organizationId: string, recipientId: string) {
  assertValidRecipientId(recipientId);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<RecipientRow>`
      SELECT id, organization_id, first_name, last_name, preferred_name, date_of_birth,
             allergies, preferences, routines, status, room_id, created_at, updated_at, archived_at
      FROM care_recipients
      WHERE id = ${recipientId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new RecipientNotFoundError();
    return result.rows[0];
  });
}

export async function updateCareRecipient(
  userId: string,
  organizationId: string,
  recipientId: string,
  input: UpdateRecipientInput
) {
  assertValidRecipientId(recipientId);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // Each SET fragment is built with Kysely's own `sql` tag, so every
    // value is still a real bound parameter -- never string-interpolated.
    // organization_id never appears in this list under any circumstance.
    const fragments: RawBuilder<unknown>[] = [];
    if (input.firstName !== undefined) fragments.push(sql`first_name = ${input.firstName}`);
    if (input.lastName !== undefined) fragments.push(sql`last_name = ${input.lastName}`);
    if (input.preferredName !== undefined)
      fragments.push(sql`preferred_name = ${input.preferredName}`);
    if (input.dateOfBirth !== undefined) fragments.push(sql`date_of_birth = ${input.dateOfBirth}`);
    if (input.allergies !== undefined) fragments.push(sql`allergies = ${input.allergies}`);
    if (input.preferences !== undefined)
      fragments.push(
        sql`preferences = ${input.preferences ? JSON.stringify(input.preferences) : null}`
      );
    if (input.routines !== undefined)
      fragments.push(sql`routines = ${input.routines ? JSON.stringify(input.routines) : null}`);
    if (input.roomId !== undefined) fragments.push(sql`room_id = ${input.roomId}`);
    if (input.status !== undefined) {
      fragments.push(sql`status = ${input.status}`);
      fragments.push(sql`archived_at = ${input.status === "archived" ? new Date().toISOString() : null}`);
    }
    fragments.push(sql`updated_at = now()`);

    const setClause = sql.join(fragments, sql`, `);

    const result = await sql<RecipientRow>`
      UPDATE care_recipients
      SET ${setClause}
      WHERE id = ${recipientId} AND organization_id = ${organizationId}
      RETURNING id, organization_id, first_name, last_name, preferred_name, date_of_birth,
                allergies, preferences, routines, status, room_id, created_at, updated_at, archived_at
    `.execute(trx);

    if (!result.rows[0]) throw new RecipientNotFoundError();
    return result.rows[0];
  });
}

// ---------------------------------------------------------------------------
// Phase 12.1: address and directions for home visits (care_recipient_locations,
// migration 082). PostgreSQL RLS is the authority; these checks only give the
// API explicit answers instead of empty results.
// ---------------------------------------------------------------------------

export class LocationWriteForbiddenError extends Error {
  constructor() {
    super("LOCATION_WRITE_FORBIDDEN");
    this.name = "LocationWriteForbiddenError";
  }
}

const optionalText = (max: number) =>
  z.string().trim().max(max).transform((value) => (value.length ? value : null)).nullable().optional();

export const upsertLocationSchema = z
  .object({
    addressLine: optionalText(200),
    municipality: optionalText(60),
    accessNotes: optionalText(500),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict()
  .refine((d) => (d.latitude == null) === (d.longitude == null), {
    message: "latitude and longitude go together",
  });
export type UpsertLocationInput = z.infer<typeof upsertLocationSchema>;

export interface CareRecipientLocation {
  care_recipient_id: string;
  address_line: string | null;
  municipality: string | null;
  access_notes: string | null;
  latitude: number | null;
  longitude: number | null;
  updated_at: string;
}

function toLocation(row: Record<string, unknown> | undefined): CareRecipientLocation | null {
  if (!row) return null;
  return {
    care_recipient_id: String(row.care_recipient_id),
    address_line: (row.address_line as string | null) ?? null,
    municipality: (row.municipality as string | null) ?? null,
    access_notes: (row.access_notes as string | null) ?? null,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    updated_at: String(row.updated_at),
  };
}

/**
 * Managers, and workers with an assigned not-yet-ended shift (or open visit)
 * for this recipient, may read. Everyone else, including family members of the
 * recipient, gets RecipientNotFoundError: no signal about the address.
 */
export async function getCareRecipientLocation(userId: string, organizationId: string, recipientId: string) {
  assertValidRecipientId(recipientId);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const access = await sql<{ allowed: boolean }>`
      SELECT (app_is_org_manager() OR app_worker_has_recipient_assignment(${recipientId}::uuid)) AS allowed
    `.execute(trx);
    if (!access.rows[0]?.allowed) throw new RecipientNotFoundError();
    const result = await sql<Record<string, unknown>>`
      SELECT care_recipient_id, address_line, municipality, access_notes, latitude, longitude, updated_at
      FROM care_recipient_locations
      WHERE care_recipient_id = ${recipientId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    return toLocation(result.rows[0]);
  });
}

/** Managers only. Creates or replaces the recipient's address in one statement. */
export async function upsertCareRecipientLocation(
  userId: string,
  organizationId: string,
  recipientId: string,
  input: UpsertLocationInput
) {
  assertValidRecipientId(recipientId);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
    if (!manager.rows[0]?.ok) throw new LocationWriteForbiddenError();
    const recipient = await sql<{ id: string }>`
      SELECT id FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!recipient.rows[0]) throw new RecipientNotFoundError();

    const result = await sql<Record<string, unknown>>`
      INSERT INTO care_recipient_locations (
        care_recipient_id, organization_id, address_line, municipality, access_notes,
        latitude, longitude, updated_at, updated_by_user_id
      ) VALUES (
        ${recipientId}, ${organizationId}, ${input.addressLine ?? null}, ${input.municipality ?? null},
        ${input.accessNotes ?? null}, ${input.latitude ?? null}, ${input.longitude ?? null}, now(), ${userId}
      )
      ON CONFLICT (care_recipient_id) DO UPDATE SET
        address_line = EXCLUDED.address_line,
        municipality = EXCLUDED.municipality,
        access_notes = EXCLUDED.access_notes,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        updated_at = now(),
        updated_by_user_id = EXCLUDED.updated_by_user_id
      RETURNING care_recipient_id, address_line, municipality, access_notes, latitude, longitude, updated_at
    `.execute(trx);
    return toLocation(result.rows[0]);
  });
}

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
    if (input.status !== undefined) fragments.push(sql`status = ${input.status}`);
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

import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";

export class WorkerNotLinkedError extends Error {
  constructor() {
    super("USER_HAS_NO_WORKER_PROFILE");
    this.name = "WorkerNotLinkedError";
  }
}
export class ShiftNotFoundError extends Error {
  constructor() {
    super("SHIFT_NOT_FOUND");
    this.name = "ShiftNotFoundError";
  }
}
export class NoActiveVisitError extends Error {
  constructor() {
    super("NO_ACTIVE_VISIT");
    this.name = "NoActiveVisitError";
  }
}
export class RecipientNotInContextError extends Error {
  constructor() {
    super("RECIPIENT_NOT_IN_SHIFT_CONTEXT");
    this.name = "RecipientNotInContextError";
  }
}
export class EventTypeNotEnabledError extends Error {
  constructor() {
    super("EVENT_TYPE_NOT_ENABLED");
    this.name = "EventTypeNotEnabledError";
  }
}
export class InvalidFileForPhotoError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidFileForPhotoError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

const mealPayload = z.object({
  mealType: z.enum(["Desayuno", "Almuerzo", "Cena", "Snack"]),
  amountConsumed: z.enum(["Poco", "Mitad", "Casi todo", "Todo"]),
});
const hydrationPayload = z.object({
  amount: z.enum(["Rechazó", "Poco", "Medio vaso", "Vaso completo"]),
});
const toiletingPayload = z.object({
  result: z.enum(["Sin novedad", "Asistencia parcial", "Asistencia total", "Requirió cambio"]),
});
const mobilityPayload = z.object({
  activity: z.enum(["No realizada", "Caminata corta", "Caminata 15 minutos", "Con asistencia", "Silla de ruedas"]),
});
const activityPayload = z.object({
  label: z.string().min(1).max(200),
  durationMinutes: z.number().int().positive().optional(),
});
const moodPayload = z.object({
  mood: z.enum(["Contento", "Tranquilo", "Triste", "Ansioso", "Confundido", "Irritable", "Somnoliento"]),
});

const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  MEAL: mealPayload,
  HYDRATION: hydrationPayload,
  TOILETING: toiletingPayload,
  MOBILITY: mobilityPayload,
  ACTIVITY: activityPayload,
  MOOD: moodPayload,
};

const MAX_NOTE_LENGTH = 4000;

export const createCareEventSchema = z.object({
  typeCode: z.string().min(1),
  careRecipientId: z.string().uuid(),
  noteText: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  storedFileId: z.string().uuid().optional(),
});
export type CreateCareEventInput = z.infer<typeof createCareEventSchema>;

interface CareEventRow {
  id: string;
  organization_id: string;
  shift_id: string;
  care_recipient_id: string;
  organization_worker_membership_id: string;
  care_event_type_id: string;
  occurred_at: string;
  note_text: string | null;
  structured_data: unknown;
  created_at: string;
}

async function resolveWorkerForUser(trx: unknown, userId: string): Promise<string> {
  const result = await sql<{ id: string }>`SELECT id FROM workers WHERE user_id = ${userId} LIMIT 1`.execute(
    trx as never
  );
  if (!result.rows[0]) throw new WorkerNotLinkedError();
  return result.rows[0].id;
}

async function resolveMembership(trx: unknown, workerId: string, organizationId: string) {
  const result = await sql<{ id: string; status: string }>`
    SELECT id, status FROM organization_worker_memberships
    WHERE worker_id = ${workerId} AND organization_id = ${organizationId}
    LIMIT 1
  `.execute(trx as never);
  return result.rows[0] ?? null;
}

async function assertActiveVisit(trx: unknown, shiftId: string, membershipId: string): Promise<void> {
  const lastCheckIn = await sql<{ occurred_at: string }>`
    SELECT occurred_at FROM verification_events
    WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membershipId} AND event_type = 'check_in'
    ORDER BY occurred_at DESC LIMIT 1
  `.execute(trx as never);
  if (!lastCheckIn.rows[0]) throw new NoActiveVisitError();

  const laterCheckOut = await sql<{ id: string }>`
    SELECT id FROM verification_events
    WHERE shift_id = ${shiftId} AND organization_worker_membership_id = ${membershipId} AND event_type = 'check_out'
      AND occurred_at > ${lastCheckIn.rows[0].occurred_at}
    LIMIT 1
  `.execute(trx as never);
  if (laterCheckOut.rows[0]) throw new NoActiveVisitError();
}

async function assertRecipientConsistency(
  trx: unknown,
  organizationId: string,
  shift: { care_recipient_id: string | null; room_id: string | null },
  careRecipientId: string
): Promise<void> {
  if (shift.care_recipient_id) {
    if (shift.care_recipient_id !== careRecipientId) throw new RecipientNotInContextError();
    return;
  }
  if (shift.room_id) {
    const match = await sql<{ id: string }>`
      SELECT id FROM care_recipients
      WHERE id = ${careRecipientId} AND organization_id = ${organizationId} AND room_id = ${shift.room_id}
      LIMIT 1
    `.execute(trx as never);
    if (!match.rows[0]) throw new RecipientNotInContextError();
    return;
  }
  throw new RecipientNotInContextError();
}

async function resolveEnabledEventType(trx: unknown, organizationId: string, typeCode: string) {
  const result = await sql<{ id: string; is_enabled: boolean | null }>`
    SELECT cet.id, ocet.is_enabled
    FROM care_event_types cet
    LEFT JOIN organization_care_event_types ocet
      ON ocet.care_event_type_id = cet.id AND ocet.organization_id = ${organizationId}
    WHERE cet.code = ${typeCode}
    LIMIT 1
  `.execute(trx as never);
  const row = result.rows[0];
  if (!row) throw new EventTypeNotEnabledError();
  if (row.is_enabled !== true) throw new EventTypeNotEnabledError();
  return row.id;
}

export async function createCareEvent(
  userId: string,
  organizationId: string,
  shiftId: string,
  input: CreateCareEventInput
): Promise<CareEventRow> {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const workerId = await resolveWorkerForUser(trx, userId);
    const membership = await resolveMembership(trx, workerId, organizationId);
    if (!membership) throw new ShiftNotFoundError();
    if (membership.status !== "active") throw new MembershipNotActiveError("Membership not active");

    const shiftRow = await sql<{ id: string; care_recipient_id: string | null; room_id: string | null; status: string }>`
      SELECT id, care_recipient_id, room_id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    const shift = shiftRow.rows[0];
    if (!shift) throw new ShiftNotFoundError();

    await assertActiveVisit(trx, shiftId, membership.id);
    await assertRecipientConsistency(trx, organizationId, shift, input.careRecipientId);
    const eventTypeId = await resolveEnabledEventType(trx, organizationId, input.typeCode);

    let structuredData: unknown = null;
    const payloadSchema = PAYLOAD_SCHEMAS[input.typeCode];
    if (payloadSchema) {
      const parsed = payloadSchema.safeParse(input.payload ?? {});
      if (!parsed.success) {
        const err = new Error("INVALID_PAYLOAD_FOR_TYPE");
        err.name = "InvalidPayloadError";
        throw err;
      }
      structuredData = parsed.data;
    } else if (input.typeCode === "PHOTO") {
      if (!input.storedFileId) {
        const err = new Error("PHOTO_REQUIRES_STORED_FILE_ID");
        err.name = "InvalidPayloadError";
        throw err;
      }
    }

    const result = await sql<CareEventRow>`
      INSERT INTO care_events (
        organization_id, shift_id, care_recipient_id, organization_worker_membership_id,
        care_event_type_id, note_text, structured_data
      ) VALUES (
        ${organizationId}, ${shiftId}, ${input.careRecipientId}, ${membership.id},
        ${eventTypeId}, ${input.noteText ?? null}, ${structuredData ? JSON.stringify(structuredData) : null}
      )
      RETURNING id, organization_id, shift_id, care_recipient_id, organization_worker_membership_id,
                care_event_type_id, occurred_at, note_text, structured_data, created_at
    `.execute(trx);
    const event = result.rows[0];

    if (input.typeCode === "PHOTO" && input.storedFileId) {
      const fileCheck = await sql<{ id: string; scope_type: string; organization_id: string | null }>`
        SELECT id, scope_type, organization_id FROM stored_files WHERE id = ${input.storedFileId} LIMIT 1
      `.execute(trx);
      const file = fileCheck.rows[0];
      if (!file) throw new InvalidFileForPhotoError("FILE_NOT_FOUND");
      if (file.scope_type !== "ORGANIZATION_OPERATIONAL") {
        throw new InvalidFileForPhotoError("FILE_MUST_BE_ORGANIZATION_OPERATIONAL");
      }
      if (file.organization_id !== organizationId) {
        throw new InvalidFileForPhotoError("FILE_OWNER_MISMATCH");
      }
      await sql`
        INSERT INTO care_event_photos (organization_id, care_event_id, file_id)
        VALUES (${organizationId}, ${event.id}, ${input.storedFileId})
      `.execute(trx);
    }

    // Notify every family member currently authorized for this recipient
    // and who opted in (can_receive_notifications) -- so a new care event
    // is discoverable even before the family portal's next timeline poll.
    // RLS (notifications_insert, migration 038) independently re-verifies
    // both this worker and each target family user are authorized for
    // THIS SAME care_recipient_id before allowing any of these inserts.
    await sql`
      INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, care_recipient_id, channel, status, sent_at)
      SELECT fr.user_id, ${organizationId}, 'NEW_CARE_EVENT', 'care_event', ${event.id}, ${input.careRecipientId}, 'in_app', 'sent', now()
      FROM family_relationships fr
      WHERE fr.care_recipient_id = ${input.careRecipientId}
        AND fr.organization_id = ${organizationId}
        AND fr.status = 'active'
        AND fr.can_receive_notifications = true
        AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN organization_memberships om ON ur.organization_membership_id = om.id
          JOIN roles r ON ur.role_id = r.id
          WHERE om.user_id = fr.user_id AND om.organization_id = ${organizationId} AND r.code = 'FAMILY'
        )
    `.execute(trx);

    return event;
  });
}

export async function listShiftCareEvents(userId: string, organizationId: string, shiftId: string) {
  assertUuid(shiftId, "shiftId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<CareEventRow & { type_code: string }>`
      SELECT ce.id, ce.organization_id, ce.shift_id, ce.care_recipient_id, ce.organization_worker_membership_id,
             ce.care_event_type_id, ce.occurred_at, ce.note_text, ce.structured_data, ce.created_at,
             cet.code as type_code
      FROM care_events ce
      JOIN care_event_types cet ON cet.id = ce.care_event_type_id
      WHERE ce.shift_id = ${shiftId} AND ce.organization_id = ${organizationId}
      ORDER BY ce.occurred_at
    `.execute(trx);
    return result.rows;
  });
}

export async function listRecipientCareEvents(userId: string, organizationId: string, careRecipientId: string) {
  assertUuid(careRecipientId, "careRecipientId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<CareEventRow & { type_code: string }>`
      SELECT ce.id, ce.organization_id, ce.shift_id, ce.care_recipient_id, ce.organization_worker_membership_id,
             ce.care_event_type_id, ce.occurred_at, ce.note_text, ce.structured_data, ce.created_at,
             cet.code as type_code
      FROM care_events ce
      JOIN care_event_types cet ON cet.id = ce.care_event_type_id
      WHERE ce.care_recipient_id = ${careRecipientId} AND ce.organization_id = ${organizationId}
      ORDER BY ce.occurred_at DESC
    `.execute(trx);
    return result.rows;
  });
}

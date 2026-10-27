import { sql } from "kysely";
import { threadAccessSql } from "../../security/roleGuards.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

export class RecipientNotFoundError extends Error {
  constructor() {
    super("RECIPIENT_NOT_FOUND");
    this.name = "RecipientNotFoundError";
  }
}
export class ConversationNotFoundError extends Error {
  constructor() {
    super("CONVERSATION_NOT_FOUND");
    this.name = "ConversationNotFoundError";
  }
}
export class NotAuthorizedForConversationError extends Error {
  constructor() {
    super("NOT_AUTHORIZED_FOR_CONVERSATION");
    this.name = "NotAuthorizedForConversationError";
  }
}
export class CannotWriteError extends Error {
  constructor() {
    super("CANNOT_WRITE_TO_CONVERSATION");
    this.name = "CannotWriteError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

const MAX_BODY_LENGTH = 4000;

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

interface ConversationRow {
  id: string;
  organization_id: string;
  care_recipient_id: string | null;
  thread_type: string;
  created_at: string;
}
interface MessageRow {
  id: string;
  organization_id: string;
  message_thread_id: string;
  sender_user_id: string;
  body: string;
  created_at: string;
}

export async function resolveOrCreateFamilyConversation(
  userId: string,
  organizationId: string,
  careRecipientId: string
): Promise<ConversationRow> {
  assertUuid(careRecipientId, "careRecipientId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // One rule for everyone (migration 132): managers, active family, or a caregiver
    // with an ACCEPTED assignment with THIS person until 24 h after that shift ended.
    // Pending, rejected or cancelled assignments never qualify. The same answer is
    // given whether the person does not exist or is not hers, so a caregiver or a
    // family member learns nothing about other residents.
    const allowed = await sql<{ ok: boolean }>`
      SELECT app_user_can_message_recipient(${userId}::uuid, ${organizationId}::uuid, ${careRecipientId}::uuid) AS ok
    `.execute(trx);
    // (false also when the person does not exist in this agency: same 403 either way)
    if (!allowed.rows[0]?.ok) throw new NotAuthorizedForConversationError();

    // Uses app_find_family_thread_id() (migration 035) rather than a plain
    // SELECT: message_threads_read requires already being a participant,
    // which is exactly what a newly-authorized (not-yet-joined) actor is
    // NOT yet -- without this helper, this lookup would always come back
    // empty for them and silently create a duplicate thread instead of
    // reusing the real one.
    const existingId = await sql<{ id: string | null }>`
      SELECT app_find_family_thread_id(${organizationId}, ${careRecipientId}) as id
    `.execute(trx);
    let thread: ConversationRow | undefined;
    if (existingId.rows[0]?.id) {
      thread = {
        id: existingId.rows[0].id,
        organization_id: organizationId,
        care_recipient_id: careRecipientId,
        thread_type: "family_agency",
        created_at: new Date().toISOString(), // not authoritative; only used if the caller reads this field, which nothing here does
      };
    }

    if (!thread) {
      const newId = randomUUID();
      await sql`
        INSERT INTO message_threads (id, organization_id, care_recipient_id, thread_type)
        VALUES (${newId}, ${organizationId}, ${careRecipientId}, 'family_agency')
      `.execute(trx);
      thread = {
        id: newId,
        organization_id: organizationId,
        care_recipient_id: careRecipientId,
        thread_type: "family_agency",
        created_at: new Date().toISOString(),
      };
    }

    await sql`
      INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
      VALUES (${organizationId}, ${thread.id}, ${userId}, true)
      ON CONFLICT (message_thread_id, user_id) DO NOTHING
    `.execute(trx);

    // Root-cause fix: resolving/creating a thread used to only ever add
    // the CALLING user as a participant. If only one side of a
    // conversation (e.g. only the caregiver, or only the family member)
    // ever called this endpoint for a given recipient, the other side
    // could never see the thread at all via listConversations/listMessages
    // (both filtered strictly by message_thread_participants.user_id) --
    // confirmed empirically. Every OTHER party independently authorized
    // for this exact recipient (active family members still holding the
    // FAMILY role, workers with an active assignment, and org
    // admins/supervisors) is now added too, idempotently. RLS
    // (message_thread_participants_write, migration 038) independently
    // re-verifies that both the calling actor and each added user are
    // authorized for this same recipient before allowing any of these
    // inserts -- this loop cannot add an unauthorized/unrelated user even
    // if the query below were wrong.
    const otherAuthorizedUsers = await sql<{ user_id: string }>`
      SELECT fr.user_id
      FROM family_relationships fr
      WHERE fr.care_recipient_id = ${careRecipientId} AND fr.organization_id = ${organizationId} AND fr.status = 'active'
        AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN organization_memberships om ON ur.organization_membership_id = om.id
          JOIN roles r ON ur.role_id = r.id
          WHERE om.user_id = fr.user_id AND om.organization_id = ${organizationId}
            AND om.status = 'active' AND r.code = 'FAMILY'
        )
      UNION
      SELECT DISTINCT w.user_id
      FROM assignments a
      JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id AND owm.status = 'active'
      JOIN workers w ON w.id = owm.worker_id
      WHERE a.organization_id = ${organizationId}
        AND a.response_status = 'accepted'
        -- only caregivers inside their window with this person (132); never past ones
        AND app_worker_messaging_window(w.user_id, ${organizationId}::uuid, ${careRecipientId}::uuid)
      UNION
      SELECT DISTINCT om.user_id
      FROM organization_memberships om
      JOIN user_roles ur ON ur.organization_membership_id = om.id
      JOIN roles r ON r.id = ur.role_id AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
      WHERE om.organization_id = ${organizationId} AND om.status = 'active'
    `.execute(trx);
    for (const other of otherAuthorizedUsers.rows) {
      if (other.user_id === userId) continue;
      await sql`
        INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
        VALUES (${organizationId}, ${thread.id}, ${other.user_id}, true)
        ON CONFLICT (message_thread_id, user_id) DO NOTHING
      `.execute(trx);
    }

    // Now that the caller is a real participant, they have genuine RLS
    // visibility on the thread -- re-fetch for authoritative field values
    // instead of the placeholder used above.
    const finalRow = await sql<ConversationRow>`
      SELECT id, organization_id, care_recipient_id, thread_type, created_at
      FROM message_threads WHERE id = ${thread.id} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);

    return finalRow.rows[0]!;
  });
}

export async function listConversations(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<ConversationRow>`
      SELECT mt.id, mt.organization_id, mt.care_recipient_id, mt.thread_type, mt.created_at
      FROM message_threads mt
      JOIN message_thread_participants mtp ON mtp.message_thread_id = mt.id
      WHERE mt.organization_id = ${organizationId} AND mtp.user_id = ${userId}
        AND ${threadAccessSql(sql`mt.id`)}
      ORDER BY mt.created_at DESC
    `.execute(trx);
    return result.rows;
  });
}

export interface ListMessagesQuery {
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export async function listMessages(
  userId: string,
  organizationId: string,
  conversationId: string,
  query: ListMessagesQuery = {}
) {
  assertUuid(conversationId, "conversationId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const threadRow = await sql<{ id: string }>`
      SELECT id FROM message_threads WHERE id = ${conversationId} AND organization_id = ${organizationId}
        AND ${threadAccessSql(sql`message_threads.id`)}
      LIMIT 1
    `.execute(trx);
    // Participants only, and only while they are still authorized for the
    // person the conversation is about (same rule as RLS messages_read, 038).
    if (!threadRow.rows[0]) throw new ConversationNotFoundError();

    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions = [sql`organization_id = ${organizationId}`, sql`message_thread_id = ${conversationId}`];
    if (query.cursor) {
      const [ts, id] = query.cursor.split("_");
      if (ts && id && uuidSchema.safeParse(id).success) {
        conditions.push(sql`(created_at, id) < (${ts}::timestamptz, ${id}::uuid)`);
      }
    }
    const result = await sql<MessageRow>`
      SELECT id, organization_id, message_thread_id, sender_user_id, body, created_at
      FROM messages
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `.execute(trx);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? `${new Date(last.created_at).toISOString()}_${last.id}` : null;

    return { messages: pageRows, nextCursor };
  });
}

export async function sendMessage(
  userId: string,
  organizationId: string,
  conversationId: string,
  input: SendMessageInput
): Promise<MessageRow> {
  assertUuid(conversationId, "conversationId");
  // Defense in depth: never trust that the route layer's Zod parse was the
  // only thing standing between an empty/whitespace-only body and the
  // database -- re-check here too, matching every other check in this
  // service (see also incidents.service.ts, scheduling.service.ts for the
  // same established pattern in this codebase).
  if (!input.body || input.body.trim().length === 0) {
    const err = new Error("BODY_REQUIRED");
    err.name = "InvalidPayloadError";
    throw err;
  }
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const participant = await sql<{ can_write: boolean }>`
      SELECT can_write FROM message_thread_participants
      WHERE message_thread_id = ${conversationId} AND organization_id = ${organizationId} AND user_id = ${userId}
        AND ${threadAccessSql(sql`message_thread_participants.message_thread_id`)}
      LIMIT 1
    `.execute(trx);
    if (!participant.rows[0]) throw new ConversationNotFoundError();
    if (!participant.rows[0].can_write) throw new CannotWriteError();

    const result = await sql<MessageRow>`
      INSERT INTO messages (organization_id, message_thread_id, sender_user_id, body)
      VALUES (${organizationId}, ${conversationId}, ${userId}, ${input.body})
      RETURNING id, organization_id, message_thread_id, sender_user_id, body, created_at
    `.execute(trx);
    const message = result.rows[0];

    // Notify only participants who may still read the conversation (a caregiver
    // whose window closed stays a participant row but is no longer notified).
    const others = await sql<{ user_id: string }>`
      SELECT mtp.user_id FROM message_thread_participants mtp
      JOIN message_threads mt ON mt.id = mtp.message_thread_id AND mt.organization_id = mtp.organization_id
      WHERE mtp.message_thread_id = ${conversationId} AND mtp.organization_id = ${organizationId} AND mtp.user_id != ${userId}
        AND (mt.care_recipient_id IS NULL
             OR app_user_can_message_recipient(mtp.user_id, mt.organization_id, mt.care_recipient_id))
    `.execute(trx);
    for (const other of others.rows) {
      await sql`
        INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
        VALUES (${other.user_id}, ${organizationId}, 'NEW_MESSAGE', 'message_thread', ${conversationId}, 'in_app', 'sent', now())
      `.execute(trx);
    }

    return message;
  });
}

/**
 * People the caller may start (or reopen) a conversation about: everyone for
 * managers, her own relatives for family, and for a caregiver only the residents
 * inside her messaging window (accepted assignment, until 24 h after that shift
 * ended). Minimal fields: id and the display name the portal already shows.
 */
export async function listStartableRecipients(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{ id: string; first_name: string; last_name: string; preferred_name: string | null }>`
      SELECT id, first_name, last_name, preferred_name FROM app_my_message_recipients()
    `.execute(trx);
    return result.rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, preferredName: r.preferred_name }));
  });
}

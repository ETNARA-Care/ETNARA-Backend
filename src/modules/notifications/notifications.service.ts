import { sql } from "kysely";
import { z } from "zod";
import { withUserContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

export class NotificationNotFoundError extends Error {
  constructor() {
    super("NOTIFICATION_NOT_FOUND");
    this.name = "NotificationNotFoundError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  cursor: z.string().optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

interface NotificationRow {
  id: string;
  organization_id: string | null;
  notification_type: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  status: string;
  created_at: string;
  read_at: string | null;
}

function summarizeType(notificationType: string): string {
  switch (notificationType) {
    case "NEW_MESSAGE":
      return "Nuevo mensaje";
    case "NEW_CARE_EVENT":
      return "Nueva actividad de cuidado";
    case "NEW_INCIDENT":
      return "Nuevo incidente";
    default:
      return "Notificación";
  }
}

export async function listMyNotifications(userId: string, query: ListNotificationsQuery = {}) {
  return withUserContext(userId, async (trx) => {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions = [sql`user_id = ${userId}`];
    if (query.cursor) {
      const [ts, id] = query.cursor.split("_");
      if (ts && id && uuidSchema.safeParse(id).success) {
        conditions.push(sql`(created_at, id) < (${ts}::timestamptz, ${id}::uuid)`);
      }
    }
    const result = await sql<NotificationRow>`
      SELECT id, organization_id, notification_type, related_entity_type, related_entity_id, status, created_at, read_at
      FROM notifications
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `.execute(trx);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? `${new Date(last.created_at).toISOString()}_${last.id}` : null;

    const items = pageRows.map((r) => ({
      id: r.id,
      type: r.notification_type,
      summary: summarizeType(r.notification_type),
      relatedEntityType: r.related_entity_type,
      relatedEntityId: r.related_entity_id,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));

    return { items, nextCursor };
  });
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<NotificationRow> {
  assertUuid(notificationId, "notificationId");
  return withUserContext(userId, async (trx) => {
    const result = await sql<NotificationRow>`
      UPDATE notifications SET read_at = now()
      WHERE id = ${notificationId} AND user_id = ${userId} AND read_at IS NULL
      RETURNING id, organization_id, notification_type, related_entity_type, related_entity_id, status, created_at, read_at
    `.execute(trx);
    if (result.rows[0]) return result.rows[0];

    const existing = await sql<NotificationRow>`
      SELECT id, organization_id, notification_type, related_entity_type, related_entity_id, status, created_at, read_at
      FROM notifications WHERE id = ${notificationId} AND user_id = ${userId} LIMIT 1
    `.execute(trx);
    if (existing.rows[0]) return existing.rows[0];
    throw new NotificationNotFoundError();
  });
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  return withUserContext(userId, async (trx) => {
    const result = await sql<{ id: string }>`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${userId} AND read_at IS NULL
      RETURNING id
    `.execute(trx);
    return result.rows.length;
  });
}

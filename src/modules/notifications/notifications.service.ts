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
  care_recipient_id: string | null;
  shift_id: string | null;
  worker_membership_id: string | null;
  status: string;
  created_at: string;
  read_at: string | null;
  item_count?: number | null;
  org_name?: string | null;
}

/**
 * 145 (M5): this code must also work against a database where 144 / 145 are not
 * applied yet (a deployment in the wrong order must not break every user's
 * notifications). The optional columns / functions are probed once and cached.
 */
let schemaProbe: { at: number; itemCount: boolean; orgName: boolean } | null = null;
async function notificationSchema(trx: Parameters<Parameters<typeof withUserContext>[1]>[0]) {
  if (schemaProbe && (schemaProbe.itemCount && schemaProbe.orgName || Date.now() - schemaProbe.at < 60_000)) return schemaProbe;
  const r = await sql<{ item_count: boolean; org_name: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.notifications'::regclass AND attname = 'item_count' AND NOT attisdropped) AS item_count,
           to_regprocedure('public.app_notification_org_name(uuid)') IS NOT NULL AS org_name`.execute(trx);
  schemaProbe = { at: Date.now(), itemCount: r.rows[0]?.item_count === true, orgName: r.rows[0]?.org_name === true };
  return schemaProbe;
}
/** Test hook. */
export function resetNotificationSchemaProbeForTests(): void { schemaProbe = null; }

function summarizeType(notificationType: string, itemCount?: number | null, orgName?: string | null): string {
  switch (notificationType) {
    // 145 (§4): never a word about photos or legal holds.
    case "AGENCY_NO_ACTIVE_ADMIN":
      return orgName
        ? `Tu agencia ${orgName} no tiene administración activa. Pide a ETNARA que restablezca una administradora.`
        : "Tu agencia no tiene administración activa. Pide a ETNARA que restablezca una administradora.";
    case "PLATFORM_AGENCY_NO_ACTIVE_ADMIN":
      return orgName ? `La agencia ${orgName} no tiene administración activa` : "Una agencia no tiene administración activa";
    // Activity photos v2 (144): the count and nothing else (no photo, resident, basis or reference).
    case "PHOTO_LEGAL_HOLD_REVIEW_OVERDUE":
      return itemCount === 1
        ? "1 fotografía con retención legal tiene la revisión vencida"
        : `${itemCount ?? 0} fotografías con retención legal tienen la revisión vencida`;
    case "NEW_MESSAGE":
      return "Nuevo mensaje";
    case "NEW_CARE_EVENT":
      return "Nueva actividad de cuidado";
    case "NEW_INCIDENT":
      return "Nuevo incidente";
    case "SHIFT_ASSIGNMENT_PENDING":
      return "Nuevo turno pendiente de respuesta";
    case "SHIFT_ASSIGNMENT_ACCEPTED":
      return "Turno aceptado por la cuidadora";
    case "SHIFT_ASSIGNMENT_REJECTED":
      return "Turno rechazado por la cuidadora";
    case "SHIFT_STARTED":
      return "La cuidadora comenzó el turno";
    case "SHIFT_COMPLETED":
      return "La cuidadora finalizó el turno";
    case "SHIFT_REPORT_READY":
      return "Tu informe de turno está listo para revisar";
    case "SHIFT_REPORT_RETURNED":
      return "La agencia devolvió tu informe de turno";
    case "CREDENTIAL_EXPIRING":
      return "Credencial próxima a vencer";
    case "CREDENTIAL_EXPIRED":
      return "Credencial vencida";
    case "CREDENTIAL_REVIEW_PENDING":
      return "Credencial pendiente de revisión";
    case "CREDENTIAL_REVIEW_APPROVED":
      return "Credencial aprobada";
    case "CREDENTIAL_REVIEW_REJECTED":
      return "Credencial rechazada";
    case "SMARTMATCH_APPLICATION_SUBMITTED":
      return "Nueva solicitud en SmartMatch";
    case "SMARTMATCH_APPLICATION_APPROVED":
      return "Tu solicitud fue aprobada";
    case "SMARTMATCH_APPLICATION_REJECTED":
      return "Tu solicitud no fue aprobada";
    case "SMARTMATCH_APPLICATION_CLOSED":
      return "La oportunidad se cubrió con otra persona";
    case "SMARTMATCH_OPPORTUNITY_CANCELLED":
      return "La agencia canceló una oportunidad que tenías aprobada";
    case "SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED":
      return "La agencia canceló una oportunidad a la que te postulaste";
    case "SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED":
      return "Venció una oportunidad a la que te postulaste";
    // Gate 7 «En camino»: never an address, a location or an estimated time.
    case "FAMILY_CAREGIVER_EN_ROUTE":
      return "La cuidadora va en camino";
    case "FAMILY_CAREGIVER_DELAYED":
      return "La cuidadora informó un retraso";
    case "FAMILY_CAREGIVER_ARRIVED":
      return "Llegada registrada";
    // Migration 113: cancellations and reassignments (never an address or a name).
    case "SHIFT_CANCELLED":
      return "La agencia canceló uno de tus turnos";
    case "SHIFT_UNASSIGNED":
      return "Ya no tienes asignado un turno";
    case "FAMILY_VISIT_CANCELLED":
      return "La agencia canceló una visita";
    case "FAMILY_CAREGIVER_CHANGED":
      return "Cambió la cuidadora de una visita";
    case "SHIFT_NOT_EN_ROUTE":
      return "Aún no registra salida (turno en 30 min)";
    case "SHIFT_DELAY_REPORTED":
      return "Retraso de 30 min o más informado";
    case "SHIFT_LATE_ARRIVAL":
      return "Turno sin llegada registrada (15 min)";
    case "SHIFT_ARRIVAL_NEEDS_REVIEW":
      return "Llegada pendiente de revisión";
    case "LOCATION_CHANGE_REQUESTED":
      return "Un familiar solicitó corregir una dirección";
    case "LOCATION_CHANGE_APPROVED":
      return "La agencia aprobó tu corrección de dirección";
    case "LOCATION_CHANGE_REJECTED":
      return "La agencia revisó tu corrección de dirección";
    default:
      return "Notificación";
  }
}

export async function listMyNotifications(userId: string, query: ListNotificationsQuery = {}) {
  return withUserContext(userId, async (trx) => {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions = [sql`user_id = ${userId}`];
    const schema = await notificationSchema(trx);
    if (query.cursor) {
      const [ts, id] = query.cursor.split("_");
      if (ts && id && uuidSchema.safeParse(id).success) {
        conditions.push(sql`(created_at, id) < (${ts}::timestamptz, ${id}::uuid)`);
      }
    }
    const result = await sql<NotificationRow>`
      SELECT id, organization_id, notification_type, related_entity_type, related_entity_id,
             care_recipient_id,
             CASE
               WHEN related_entity_type = 'assignment'
                 THEN app_notification_assignment_shift_id(id)
               WHEN related_entity_type = 'shift'
                 THEN related_entity_id
               ELSE NULL
             END AS shift_id,
             CASE
               WHEN related_entity_type = 'credential'
                 THEN app_notification_credential_membership_id(id)
               ELSE NULL
             END AS worker_membership_id,
             status, created_at, read_at,
             ${schema.itemCount ? sql`item_count` : sql`NULL::int AS item_count`},
             ${schema.orgName ? sql`CASE WHEN notification_type IN ('PLATFORM_AGENCY_NO_ACTIVE_ADMIN', 'AGENCY_NO_ACTIVE_ADMIN') THEN app_notification_org_name(id) END` : sql`NULL::text`} AS org_name
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
      summary: summarizeType(r.notification_type, r.item_count, r.org_name),
      itemCount: r.item_count ?? null,
      relatedEntityType: r.related_entity_type,
      relatedEntityId: r.related_entity_id,
      careRecipientId: r.care_recipient_id,
      shiftId: r.shift_id,
      workerMembershipId: r.worker_membership_id,
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
      RETURNING id, organization_id, notification_type, related_entity_type, related_entity_id,
                care_recipient_id, NULL::uuid AS shift_id, NULL::uuid AS worker_membership_id,
                status, created_at, read_at
    `.execute(trx);
    if (result.rows[0]) return result.rows[0];

    const existing = await sql<NotificationRow>`
      SELECT id, organization_id, notification_type, related_entity_type, related_entity_id,
             care_recipient_id, NULL::uuid AS shift_id, NULL::uuid AS worker_membership_id,
             status, created_at, read_at
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

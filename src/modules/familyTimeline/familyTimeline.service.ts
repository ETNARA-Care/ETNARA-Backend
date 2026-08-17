import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError } from "../../context/errors.js";

export class RecipientNotFoundError extends Error {
  constructor() {
    super("RECIPIENT_NOT_FOUND");
    this.name = "RecipientNotFoundError";
  }
}
export class InvalidDateRangeError extends Error {
  constructor() {
    super("INVALID_DATE_RANGE");
    this.name = "InvalidDateRangeError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_NOTE_CHARS = 500;

export const timelineQuerySchema = z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  cursor: z.string().optional(),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

interface TimelineItem {
  id: string;
  type: string;
  occurredAt: string;
  title: string;
  summary: string;
  caregiver: { displayName: string | null; role: string | null };
  photo?: { visible: boolean; reference?: string };
}

export interface TimelineResult {
  items: TimelineItem[];
  nextCursor: string | null;
}

function summarizeEvent(
  typeCode: string,
  structuredData: unknown,
  noteText: string | null
): { title: string; summary: string } {
  const data = (structuredData ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

  switch (typeCode) {
    case "MEAL": {
      const mealType = str(data.mealType);
      const amount = str(data.amountConsumed);
      return { title: "Comida", summary: [mealType, amount].filter(Boolean).join(" · ") || "Comida registrada" };
    }
    case "HYDRATION": {
      const amount = str(data.amount);
      return { title: "Hidratación", summary: amount ? `Tomó: ${amount}` : "Hidratación registrada" };
    }
    case "TOILETING": {
      const result = str(data.result);
      return { title: "Baño", summary: result ?? "Registro de baño" };
    }
    case "MOBILITY": {
      const activity = str(data.activity);
      return { title: "Movilidad", summary: activity ?? "Registro de movilidad" };
    }
    case "ACTIVITY": {
      const label = str(data.label);
      const duration = typeof data.durationMinutes === "number" ? data.durationMinutes : null;
      return {
        title: "Actividad",
        summary: [label, duration ? `${duration} min` : null].filter(Boolean).join(" · ") || "Actividad registrada",
      };
    }
    case "MOOD": {
      const mood = str(data.mood);
      return { title: "Estado de ánimo", summary: mood ?? "Estado de ánimo registrado" };
    }
    case "NOTE": {
      const trimmed = (noteText ?? "").trim();
      const truncated = trimmed.length > MAX_NOTE_CHARS ? trimmed.slice(0, MAX_NOTE_CHARS) + "…" : trimmed;
      return { title: "Nota", summary: truncated || "Nota registrada" };
    }
    case "PHOTO":
      return { title: "Foto", summary: "Foto registrada" };
    default:
      return { title: "Evento", summary: "Evento registrado" };
  }
}

export async function getFamilyTimeline(
  userId: string,
  organizationId: string,
  careRecipientId: string,
  query: TimelineQuery
): Promise<TimelineResult> {
  assertUuid(careRecipientId, "careRecipientId");
  if (query.dateFrom && query.dateTo && new Date(query.dateFrom).getTime() > new Date(query.dateTo).getTime()) {
    throw new InvalidDateRangeError();
  }

  return withTenantContext({ userId, organizationId }, async (trx) => {
    const relationship = await sql<{ can_view_photos: boolean }>`
      SELECT can_view_photos FROM family_relationships
      WHERE user_id = ${userId} AND organization_id = ${organizationId}
        AND care_recipient_id = ${careRecipientId} AND status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!relationship.rows[0]) throw new RecipientNotFoundError();
    const canViewPhotos = relationship.rows[0].can_view_photos;

    const recipientRow = await sql<{ id: string }>`
      SELECT id FROM care_recipients WHERE id = ${careRecipientId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!recipientRow.rows[0]) throw new RecipientNotFoundError();

    const limit = query.limit ?? DEFAULT_LIMIT;
    const conditions = [sql`ce.organization_id = ${organizationId}`, sql`ce.care_recipient_id = ${careRecipientId}`];
    if (query.dateFrom) conditions.push(sql`ce.occurred_at >= ${query.dateFrom}`);
    if (query.dateTo) conditions.push(sql`ce.occurred_at <= ${query.dateTo}`);

    if (query.cursor) {
      const [cursorTs, cursorId] = query.cursor.split("_");
      if (cursorTs && cursorId && uuidSchema.safeParse(cursorId).success) {
        conditions.push(sql`(ce.occurred_at, ce.id) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`);
      }
    }

    const result = await sql<{
      id: string;
      type_code: string;
      occurred_at: string;
      note_text: string | null;
      structured_data: unknown;
      membership_id: string;
    }>`
      SELECT ce.id, cet.code as type_code, ce.occurred_at, ce.note_text, ce.structured_data,
             ce.organization_worker_membership_id as membership_id
      FROM care_events ce
      JOIN care_event_types cet ON cet.id = ce.care_event_type_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ce.occurred_at DESC, ce.id DESC
      LIMIT ${limit + 1}
    `.execute(trx);

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const membershipIds = [...new Set(pageRows.map((r) => r.membership_id))];
    const caregiverMap = new Map<string, { displayName: string | null; role: string | null }>();
    if (membershipIds.length > 0) {
      const caregivers = await sql<{ membership_id: string; display_name: string | null; internal_role: string | null }>`
        SELECT owm.id as membership_id, w.display_name, owm.internal_role
        FROM organization_worker_memberships owm
        JOIN workers w ON w.id = owm.worker_id
        WHERE owm.id = ANY(${membershipIds})
      `.execute(trx);
      for (const c of caregivers.rows) {
        caregiverMap.set(c.membership_id, { displayName: c.display_name, role: c.internal_role });
      }
    }

    const photoEventIds = pageRows.filter((r) => r.type_code === "PHOTO").map((r) => r.id);
    const photoRefMap = new Map<string, string>();
    if (canViewPhotos && photoEventIds.length > 0) {
      const photos = await sql<{ care_event_id: string; id: string }>`
        SELECT id, care_event_id FROM care_event_photos
        WHERE care_event_id = ANY(${photoEventIds})
      `.execute(trx);
      for (const p of photos.rows) photoRefMap.set(p.care_event_id, p.id);
    }

    const items: TimelineItem[] = pageRows.map((row) => {
      const { title, summary } = summarizeEvent(row.type_code, row.structured_data, row.note_text);
      const caregiver = caregiverMap.get(row.membership_id) ?? { displayName: null, role: null };
      const item: TimelineItem = { id: row.id, type: row.type_code, occurredAt: row.occurred_at, title, summary, caregiver };
      if (row.type_code === "PHOTO") {
        const ref = photoRefMap.get(row.id);
        item.photo = ref ? { visible: true, reference: ref } : { visible: false };
      }
      return item;
    });

    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? `${new Date(last.occurred_at).toISOString()}_${last.id}` : null;

    return { items, nextCursor };
  });
}

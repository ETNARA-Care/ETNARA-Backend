import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

/**
 * Informe de Turno F1 (migration 124).
 *
 * A report is a snapshot of records that ALREADY exist for one caregiver's visit:
 * «Llegué» (shift_arrivals), start and end (verification_events), care events of
 * that visit, and the incidents / observations she filed during it. Nothing is
 * invented: a section without records is an empty list, and no plan task is ever
 * marked done or pending (F5, postponed). The source records are only read.
 *
 * F1: agency managers (ORGANIZATION_ADMIN / SUPERVISOR) see drafts, which are
 * built automatically for finished visits, refresh a draft, and approve it with
 * the sections the family may see (used by F3). RLS (124) enforces the same.
 */

export class ShiftReportError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "ShiftReportError";
  }
}

/** What the family may see once approved (F3). Defaults decided by ETNARA (25-oct-2026). */
export const FAMILY_SECTION_DEFAULTS = {
  schedule: true, meals: true, hydration: true, activities: true, mobility: true, observations: true,
  hygiene: false, mood: false, incidents: false, photos: false,
} as const;
type FamilySections = { [K in keyof typeof FAMILY_SECTION_DEFAULTS]: boolean };

export const approveSchema = z.object({
  /** The draft the agency read: approving a draft that changed meanwhile is refused. */
  expectedGeneratedAt: z.string().datetime({ offset: true }),
  familySections: z.object(Object.fromEntries(Object.keys(FAMILY_SECTION_DEFAULTS).map((k) => [k, z.boolean().optional()])) as
    Record<keyof FamilySections, z.ZodOptional<z.ZodBoolean>>).strict().default({}),
  agencySummary: z.string().trim().min(1).max(1000).optional(),
}).strict();
export const listSchema = z.object({
  status: z.enum(["DRAFT", "APPROVED"]).optional(),
}).strict();

const AUTO_DRAFT_DAYS = 7;
const AUTO_DRAFT_LIMIT = 50;
const TEXT_MAX = 2000;

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];
type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.slice(0, TEXT_MAX) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

async function assertManager(trx: Trx) {
  const ok = (await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx)).rows[0]?.ok;
  if (!ok) throw new ShiftReportError("SHIFT_REPORT_FORBIDDEN", 403);
}

interface Visit { membershipId: string; startAt: string; startOffline: boolean; endAt: string; endOffline: boolean }

/** Finished visits of a shift: each caregiver's first check-in and the check-out that closed it. */
async function finishedVisits(trx: Trx, organizationId: string, shiftId: string): Promise<{ visits: Visit[]; open: number }> {
  const rows = (await sql<{ membership_id: string; event_type: string; occurred_at: string; recorded_offline: boolean }>`
    SELECT organization_worker_membership_id AS membership_id, event_type, occurred_at, recorded_offline
    FROM verification_events WHERE organization_id = ${organizationId} AND shift_id = ${shiftId}
    ORDER BY occurred_at`.execute(trx)).rows;
  const byMember = new Map<string, typeof rows>();
  for (const r of rows) byMember.set(r.membership_id, [...(byMember.get(r.membership_id) ?? []), r]);
  const visits: Visit[] = [];
  let open = 0;
  for (const [membershipId, list] of byMember) {
    const start = list.find((e) => e.event_type === "check_in");
    if (!start) continue;
    const lastIn = [...list].reverse().find((e) => e.event_type === "check_in")!;
    const end = [...list].reverse().find((e) => e.event_type === "check_out" && e.occurred_at > lastIn.occurred_at);
    if (!end) { open += 1; continue; }
    visits.push({ membershipId, startAt: iso(start.occurred_at)!, startOffline: start.recorded_offline,
      endAt: iso(end.occurred_at)!, endOffline: end.recorded_offline });
  }
  return { visits, open };
}

/** The snapshot. Only fields the records already hold; free text kept verbatim (never translated). */
async function buildContent(trx: Trx, organizationId: string, shiftId: string, visit: Visit): Promise<Json> {
  const head = (await sql<{ shift_id: string; scheduled_start: string; scheduled_end: string; care_recipient_id: string;
    org_name: string; first_name: string; last_name: string | null; preferred_name: string | null; caregiver_name: string | null }>`
    SELECT s.id AS shift_id, s.scheduled_start, s.scheduled_end, s.care_recipient_id, o.name AS org_name,
           cr.first_name, cr.last_name, cr.preferred_name, w.display_name AS caregiver_name
    FROM shifts s
    JOIN organizations o ON o.id = s.organization_id
    JOIN care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
    JOIN organization_worker_memberships owm ON owm.id = ${visit.membershipId} AND owm.organization_id = s.organization_id
    LEFT JOIN workers w ON w.id = owm.worker_id
    WHERE s.id = ${shiftId} AND s.organization_id = ${organizationId}`.execute(trx)).rows[0];
  if (!head) throw new ShiftReportError("SHIFT_NOT_FOUND", 404);

  const arrival = (await sql<{ occurred_at: string; proximity: string; recorded_offline: boolean; needs_review: boolean; reviewed_at: string | null }>`
    SELECT occurred_at, proximity, recorded_offline, needs_review, reviewed_at FROM shift_arrivals
    WHERE organization_id = ${organizationId} AND shift_id = ${shiftId} AND organization_worker_membership_id = ${visit.membershipId}`.execute(trx)).rows[0];

  const events = (await sql<{ id: string; code: string; occurred_at: string; note_text: string | null; structured_data: Json | null }>`
    SELECT ce.id, t.code, ce.occurred_at, ce.note_text, ce.structured_data
    FROM care_events ce JOIN care_event_types t ON t.id = ce.care_event_type_id
    WHERE ce.organization_id = ${organizationId} AND ce.shift_id = ${shiftId}
      AND ce.organization_worker_membership_id = ${visit.membershipId}
    ORDER BY ce.occurred_at, ce.id`.execute(trx)).rows;

  const sections: Record<string, Json[]> = { meals: [], hydration: [], hygiene: [], mobility: [], activities: [], mood: [], notes: [] };
  let photoEvents = 0;
  for (const e of events) {
    const d = (e.structured_data && typeof e.structured_data === "object" ? e.structured_data : {}) as Json;
    const base = { careEventId: e.id, at: iso(e.occurred_at), note: str(e.note_text) };
    if (e.code === "MEAL") sections.meals.push({ ...base, mealType: str(d.mealType), amountConsumed: str(d.amountConsumed) });
    else if (e.code === "HYDRATION") sections.hydration.push({ ...base, amount: str(d.amount) });
    else if (e.code === "TOILETING") sections.hygiene.push({ ...base, result: str(d.result) });
    else if (e.code === "MOBILITY") sections.mobility.push({ ...base, activity: str(d.activity) });
    else if (e.code === "ACTIVITY") sections.activities.push({ ...base, label: str(d.label), durationMinutes: num(d.durationMinutes) });
    else if (e.code === "MOOD") sections.mood.push({ ...base, mood: str(d.mood) });
    else if (e.code === "NOTE") sections.notes.push({ careEventId: e.id, at: iso(e.occurred_at), text: str(e.note_text) });
    else if (e.code === "PHOTO") photoEvents += 1;
  }
  const photos = events.length
    ? Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM care_event_photos p
        WHERE p.organization_id = ${organizationId} AND p.care_event_id = ANY(${events.map((e) => e.id)}::uuid[])`.execute(trx)).rows[0]?.n ?? 0)
    : 0;

  // Incidents / observations have no shift_id: those she filed for this recipient during the visit.
  const incidents = (await sql<{ id: string; created_at: string; severity: string; status: string; description: string }>`
    SELECT id, created_at, severity, status::text AS status, description FROM incidents
    WHERE organization_id = ${organizationId} AND care_recipient_id = ${head.care_recipient_id}
      AND organization_worker_membership_id = ${visit.membershipId}
      AND created_at BETWEEN ${visit.startAt}::timestamptz AND ${visit.endAt}::timestamptz
    ORDER BY created_at`.execute(trx)).rows;
  const observations = (await sql<{ id: string; created_at: string; category: string; status: string; description: string | null }>`
    SELECT id, created_at, category::text AS category, status::text AS status, description FROM observations
    WHERE organization_id = ${organizationId} AND care_recipient_id = ${head.care_recipient_id}
      AND organization_worker_membership_id = ${visit.membershipId}
      AND created_at BETWEEN ${visit.startAt}::timestamptz AND ${visit.endAt}::timestamptz
    ORDER BY created_at`.execute(trx)).rows;

  const recipientName = head.preferred_name?.trim() || [head.first_name, head.last_name].filter(Boolean).join(" ");
  return {
    schema: 1,
    organization: { name: head.org_name },
    recipient: { id: head.care_recipient_id, name: recipientName },
    caregiver: { membershipId: visit.membershipId, name: head.caregiver_name },
    shift: { id: head.shift_id, scheduledStart: iso(head.scheduled_start), scheduledEnd: iso(head.scheduled_end) },
    times: {
      arrival: arrival ? { at: iso(arrival.occurred_at), proximity: arrival.proximity, recordedOffline: arrival.recorded_offline,
        needsReview: arrival.needs_review, reviewed: arrival.reviewed_at !== null } : null,
      start: { at: visit.startAt, recordedOffline: visit.startOffline },
      end: { at: visit.endAt, recordedOffline: visit.endOffline },
    },
    sections,
    incidents: incidents.map((i) => ({ incidentId: i.id, at: iso(i.created_at), severity: i.severity, status: i.status, description: str(i.description) })),
    observations: observations.map((o) => ({ observationId: o.id, at: iso(o.created_at), category: o.category, status: o.status, description: str(o.description) })),
    photos: { count: photos, photoEvents },
    totals: { careEvents: events.length, incidents: incidents.length, observations: observations.length },
  };
}

const counts = (c: Json) => (c.totals ?? {}) as Json;

async function appendEvent(trx: Trx, organizationId: string, reportId: string, userId: string, eventType: string, details: Json, note?: string) {
  await sql`INSERT INTO shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, note, details)
    VALUES (${organizationId}, ${reportId}, ${eventType}, ${userId}, ${note ?? null}, ${JSON.stringify(details)}::jsonb)`.execute(trx);
}

/** Creates the missing draft for every finished visit of a shift. Idempotent (unique key). */
async function ensureDrafts(trx: Trx, userId: string, organizationId: string, shiftId: string) {
  const { visits, open } = await finishedVisits(trx, organizationId, shiftId);
  for (const visit of visits) {
    const exists = await sql`SELECT 1 FROM shift_reports WHERE organization_id = ${organizationId} AND shift_id = ${shiftId}
      AND organization_worker_membership_id = ${visit.membershipId} AND version = 1`.execute(trx);
    if (exists.rows[0]) continue;
    const content = await buildContent(trx, organizationId, shiftId, visit);
    const inserted = (await sql<{ id: string }>`
      INSERT INTO shift_reports (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, content)
      VALUES (${organizationId}, ${shiftId}, ${visit.membershipId}, ${(content.recipient as Json).id as string}, ${JSON.stringify(content)}::jsonb)
      ON CONFLICT (organization_id, shift_id, organization_worker_membership_id, version) DO NOTHING
      RETURNING id`.execute(trx)).rows[0];
    if (inserted) await appendEvent(trx, organizationId, inserted.id, userId, "GENERATED", counts(content));
  }
  return { visits: visits.length, open };
}

interface ReportRow {
  id: string; shift_id: string; organization_worker_membership_id: string; care_recipient_id: string; version: number; status: string;
  content: Json; family_sections: Json | null; agency_summary: string | null; generated_at: string; approved_at: string | null;
  approved_by_user_id: string | null; approver_email: string | null;
}
const REPORT_COLUMNS = sql`r.id, r.shift_id, r.organization_worker_membership_id, r.care_recipient_id, r.version, r.status, r.content,
  r.family_sections, r.agency_summary, r.generated_at, r.approved_at, r.approved_by_user_id, u.email AS approver_email`;

function toReport(r: ReportRow, history?: Json[]) {
  return {
    id: r.id, shiftId: r.shift_id, membershipId: r.organization_worker_membership_id, careRecipientId: r.care_recipient_id,
    version: r.version, status: r.status, content: r.content, familySections: r.family_sections, agencySummary: r.agency_summary,
    generatedAt: iso(r.generated_at), approvedAt: iso(r.approved_at), approvedBy: r.approved_by_user_id ? { userId: r.approved_by_user_id, email: r.approver_email } : null,
    ...(history ? { history } : {}),
  };
}

async function historyOf(trx: Trx, reportId: string) {
  return (await sql<{ event_type: string; created_at: string; actor_user_id: string | null; email: string | null; note: string | null; details: Json }>`
    SELECT e.event_type, e.created_at, e.actor_user_id, u.email, e.note, e.details
    FROM shift_report_events e LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.shift_report_id = ${reportId} ORDER BY e.created_at, e.id`.execute(trx)).rows
    .map((e) => ({ type: e.event_type, at: iso(e.created_at), actor: e.actor_user_id ? { userId: e.actor_user_id, email: e.email } : null, note: e.note, details: e.details }));
}

/** GET /shifts/:shiftId/shift-reports: the shift's reports, creating missing drafts for finished visits. */
export async function getShiftReports(userId: string, organizationId: string, shiftId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const shift = (await sql<{ id: string; care_recipient_id: string | null; status: string }>`
      SELECT id, care_recipient_id, status FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!shift) throw new ShiftReportError("SHIFT_NOT_FOUND", 404);
    if (!shift.care_recipient_id) throw new ShiftReportError("SHIFT_WITHOUT_RECIPIENT", 409);
    const { visits, open } = await ensureDrafts(trx, userId, organizationId, shiftId);
    const rows = (await sql<ReportRow>`SELECT ${REPORT_COLUMNS} FROM shift_reports r LEFT JOIN users u ON u.id = r.approved_by_user_id
      WHERE r.organization_id = ${organizationId} AND r.shift_id = ${shiftId} ORDER BY r.generated_at, r.version`.execute(trx)).rows;
    const reports = [];
    for (const r of rows) reports.push(toReport(r, await historyOf(trx, r.id)));
    return { reports, finishedVisits: visits, openVisits: open };
  });
}

/** GET /shift-reports: recent reports; drafts for visits finished in the last 7 days appear on their own. */
export async function listShiftReports(userId: string, organizationId: string, input: z.infer<typeof listSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const pending = (await sql<{ shift_id: string }>`
      SELECT DISTINCT ve.shift_id FROM verification_events ve
      JOIN shifts s ON s.id = ve.shift_id AND s.organization_id = ve.organization_id AND s.care_recipient_id IS NOT NULL
      WHERE ve.organization_id = ${organizationId} AND ve.event_type = 'check_out'
        AND ve.occurred_at > now() - make_interval(days => ${AUTO_DRAFT_DAYS})
        AND NOT EXISTS (SELECT 1 FROM shift_reports r WHERE r.organization_id = ve.organization_id AND r.shift_id = ve.shift_id
                        AND r.organization_worker_membership_id = ve.organization_worker_membership_id)
      LIMIT ${AUTO_DRAFT_LIMIT}`.execute(trx)).rows;
    for (const p of pending) await ensureDrafts(trx, userId, organizationId, p.shift_id);
    const rows = (await sql<ReportRow>`SELECT ${REPORT_COLUMNS} FROM shift_reports r LEFT JOIN users u ON u.id = r.approved_by_user_id
      WHERE r.organization_id = ${organizationId} AND r.status <> 'SUPERSEDED'
        ${input.status ? sql`AND r.status = ${input.status}` : sql``}
      ORDER BY (r.content->'shift'->>'scheduledStart') DESC NULLS LAST, r.version DESC LIMIT 200`.execute(trx)).rows;
    return {
      reports: rows.map((r) => {
        const c = r.content as Json;
        return { id: r.id, shiftId: r.shift_id, status: r.status, version: r.version, generatedAt: iso(r.generated_at), approvedAt: iso(r.approved_at),
          recipientName: (c.recipient as Json)?.name ?? null, caregiverName: (c.caregiver as Json)?.name ?? null,
          scheduledStart: (c.shift as Json)?.scheduledStart ?? null, scheduledEnd: (c.shift as Json)?.scheduledEnd ?? null, totals: c.totals ?? null };
      }),
    };
  });
}

async function lockReport(trx: Trx, organizationId: string, reportId: string) {
  const r = (await sql<ReportRow & { organization_id: string }>`SELECT ${REPORT_COLUMNS} FROM shift_reports r LEFT JOIN users u ON u.id = r.approved_by_user_id
    WHERE r.id = ${reportId} AND r.organization_id = ${organizationId} FOR UPDATE OF r`.execute(trx)).rows[0];
  if (!r) throw new ShiftReportError("SHIFT_REPORT_NOT_FOUND", 404);
  return r;
}

/** POST /shift-reports/:id/refresh: rebuild a DRAFT from the records (e.g. an offline record that arrived later). */
export async function refreshShiftReport(userId: string, organizationId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const r = await lockReport(trx, organizationId, reportId);
    if (r.status !== "DRAFT") throw new ShiftReportError("SHIFT_REPORT_NOT_DRAFT", 409);
    const { visits } = await finishedVisits(trx, organizationId, r.shift_id);
    const visit = visits.find((v) => v.membershipId === r.organization_worker_membership_id);
    if (!visit) throw new ShiftReportError("SHIFT_VISIT_NOT_FINISHED", 409);
    const content = await buildContent(trx, organizationId, r.shift_id, visit);
    await sql`UPDATE shift_reports SET content = ${JSON.stringify(content)}::jsonb, generated_at = clock_timestamp() WHERE id = ${reportId}`.execute(trx);
    await appendEvent(trx, organizationId, reportId, userId, "REGENERATED", counts(content));
    const fresh = await lockReport(trx, organizationId, reportId);
    return { report: toReport(fresh, await historyOf(trx, reportId)) };
  });
}

/** POST /shift-reports/:id/approve: DRAFT -> APPROVED with the family sections. Approved reports never change. */
export async function approveShiftReport(userId: string, organizationId: string, reportId: string, input: z.infer<typeof approveSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const r = await lockReport(trx, organizationId, reportId);
    if (r.status === "APPROVED" || r.status === "SUPERSEDED") throw new ShiftReportError("SHIFT_REPORT_ALREADY_APPROVED", 409);
    if (r.status !== "DRAFT") throw new ShiftReportError("SHIFT_REPORT_NOT_DRAFT", 409);
    if (new Date(input.expectedGeneratedAt).getTime() !== new Date(r.generated_at).getTime()) throw new ShiftReportError("SHIFT_REPORT_CHANGED", 409);
    const familySections: FamilySections = { ...FAMILY_SECTION_DEFAULTS, ...input.familySections } as FamilySections;
    await sql`UPDATE shift_reports SET status = 'APPROVED', approved_at = now(), approved_by_user_id = ${userId},
      family_sections = ${JSON.stringify(familySections)}::jsonb, agency_summary = ${input.agencySummary ?? null}
      WHERE id = ${reportId}`.execute(trx);
    await appendEvent(trx, organizationId, reportId, userId, "APPROVED", { familySections, summary: Boolean(input.agencySummary) });
    const fresh = await lockReport(trx, organizationId, reportId);
    return { report: toReport(fresh, await historyOf(trx, reportId)) };
  });
}

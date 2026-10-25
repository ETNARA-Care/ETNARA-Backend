import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

/**
 * Informe de Turno F1 (migration 126).
 *
 * A report is a snapshot of records that ALREADY exist for one caregiver's visit:
 * «Llegué» (shift_arrivals), start and end (verification_events), care events of
 * that visit, and the incidents / observations she filed during it. Nothing is
 * invented: a section without records is an empty list, and no plan task is ever
 * marked done or pending (F5, postponed). The source records are only read.
 *
 * F1: agency managers (ORGANIZATION_ADMIN / SUPERVISOR) see drafts, which are
 * built automatically for finished visits, refresh a draft, and approve it with
 * the sections the family may see (used by F3). RLS (126) enforces the same.
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
  /** PENDING = DRAFT, SUBMITTED or RETURNED (everything the agency still has to approve). */
  status: z.enum(["DRAFT", "SUBMITTED", "RETURNED", "APPROVED", "PENDING"]).optional(),
}).strict();

const AUTO_DRAFT_DAYS = 7;
const AUTO_DRAFT_LIMIT = 50;

type Trx = Parameters<Parameters<typeof withTenantContext>[1]>[0];
type Json = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/** Admins of the agency, or supervisors an admin expressly authorized (126). Independent of Finanzas/SmartMatch/Horas. */
async function assertManager(trx: Trx) {
  const ok = (await sql<{ ok: boolean }>`SELECT app_can_review_shift_reports() AS ok`.execute(trx)).rows[0]?.ok;
  if (!ok) throw new ShiftReportError("SHIFT_REPORT_FORBIDDEN", 403);
}
async function assertAdmin(trx: Trx) {
  const ok = (await sql<{ ok: boolean }>`SELECT app_is_shift_report_admin() AS ok`.execute(trx)).rows[0]?.ok;
  if (!ok) throw new ShiftReportError("SHIFT_REPORT_ADMIN_ONLY", 403);
}

/** Database errors raised by the 128 functions, mapped to fixed API codes. */
const DB_ERRORS: Record<string, [string, number]> = {
  SHIFT_REPORT_FORBIDDEN: ["SHIFT_REPORT_FORBIDDEN", 403], SHIFT_REPORT_NOT_FOUND: ["SHIFT_REPORT_NOT_FOUND", 404],
  SHIFT_REPORT_NOT_DRAFT: ["SHIFT_REPORT_NOT_DRAFT", 409], SHIFT_REPORT_NOT_SUBMITTED: ["SHIFT_REPORT_NOT_SUBMITTED", 409],
  SHIFT_REPORT_WINDOW_CLOSED: ["SHIFT_REPORT_WINDOW_CLOSED", 409], SHIFT_REPORT_NOT_EDITABLE: ["SHIFT_REPORT_NOT_EDITABLE", 409],
  SHIFT_VISIT_NOT_FINISHED: ["SHIFT_VISIT_NOT_FINISHED", 409], RETURN_NOTE_REQUIRED: ["RETURN_NOTE_REQUIRED", 400],
  OBSERVATION_INVALID: ["OBSERVATION_INVALID", 400], FEATURE_NOT_ENABLED: ["FEATURE_NOT_ENABLED", 404],
};
export async function callDb<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const message = (error as { message?: string })?.message ?? "";
    const hit = Object.keys(DB_ERRORS).find((k) => message.includes(k));
    if (hit) throw new ShiftReportError(DB_ERRORS[hit][0], DB_ERRORS[hit][1]);
    throw error;
  }
}

/** Visits of the shift still in progress (a draft appears when they end). */
async function openVisits(trx: Trx, organizationId: string, shiftId: string) {
  const r = await sql<{ n: number }>`
    SELECT count(DISTINCT ci.organization_worker_membership_id)::int AS n FROM verification_events ci
    WHERE ci.organization_id = ${organizationId} AND ci.shift_id = ${shiftId} AND ci.event_type = 'check_in'
      AND NOT EXISTS (SELECT 1 FROM verification_events co WHERE co.shift_id = ci.shift_id AND co.event_type = 'check_out'
        AND co.organization_worker_membership_id = ci.organization_worker_membership_id
        AND co.occurred_at > (SELECT max(x.occurred_at) FROM verification_events x WHERE x.shift_id = ci.shift_id
          AND x.event_type = 'check_in' AND x.organization_worker_membership_id = ci.organization_worker_membership_id))`.execute(trx);
  return Number(r.rows[0]?.n ?? 0);
}

async function appendEvent(trx: Trx, organizationId: string, reportId: string, userId: string, eventType: string, details: Json, note?: string) {
  await sql`INSERT INTO shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, note, details)
    VALUES (${organizationId}, ${reportId}, ${eventType}, ${userId}, ${note ?? null}, ${JSON.stringify(details)}::jsonb)`.execute(trx);
}

interface ReportRow {
  id: string; shift_id: string; organization_worker_membership_id: string; care_recipient_id: string; version: number; status: string;
  content: Json; family_sections: Json | null; agency_summary: string | null; generated_at: string; approved_at: string | null;
  approved_by_user_id: string | null; approver_email: string | null; review_deadline_at: string | null; caregiver_note: string | null;
  caregiver_note_at: string | null; submitted_at: string | null;
}
const REPORT_COLUMNS = sql`r.id, r.shift_id, r.organization_worker_membership_id, r.care_recipient_id, r.version, r.status, r.content,
  r.family_sections, r.agency_summary, r.generated_at, r.approved_at, r.approved_by_user_id, u.email AS approver_email,
  r.review_deadline_at, r.caregiver_note, r.caregiver_note_at, r.submitted_at`;

/** A draft never sent by the caregiver before her 24 h ended: still DRAFT, unchanged; the agency reviews it. */
const windowExpired = (r: ReportRow) => r.status === "DRAFT" && r.review_deadline_at !== null && new Date(r.review_deadline_at).getTime() < Date.now();

function toReport(r: ReportRow, history?: Json[]) {
  return {
    id: r.id, shiftId: r.shift_id, membershipId: r.organization_worker_membership_id, careRecipientId: r.care_recipient_id,
    version: r.version, status: r.status, content: r.content, familySections: r.family_sections, agencySummary: r.agency_summary,
    generatedAt: iso(r.generated_at), approvedAt: iso(r.approved_at), approvedBy: r.approved_by_user_id ? { userId: r.approved_by_user_id, email: r.approver_email } : null,
    reviewDeadlineAt: iso(r.review_deadline_at), caregiverNote: r.caregiver_note, caregiverNoteAt: iso(r.caregiver_note_at),
    submittedAt: iso(r.submitted_at), caregiverWindowExpired: windowExpired(r),
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
    // One builder for everyone (128): the database creates any missing draft and notifies the caregiver.
    await callDb(() => sql`SELECT app_shift_report_ensure(${shiftId}::uuid)`.execute(trx));
    const rows = (await sql<ReportRow>`SELECT ${REPORT_COLUMNS} FROM shift_reports r LEFT JOIN users u ON u.id = r.approved_by_user_id
      WHERE r.organization_id = ${organizationId} AND r.shift_id = ${shiftId} ORDER BY r.generated_at, r.version`.execute(trx)).rows;
    // The portal hides «Aprobar» on the reviewer's own visit (the approval itself is refused anyway).
    const mine = new Set((await sql<{ id: string }>`SELECT owm.id FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
      WHERE owm.organization_id = ${organizationId} AND w.user_id = ${userId}`.execute(trx)).rows.map((m) => m.id));
    const reports = [];
    for (const r of rows) reports.push({ ...toReport(r, await historyOf(trx, r.id)), ownVisit: mine.has(r.organization_worker_membership_id) });
    return { reports, finishedVisits: rows.length, openVisits: await openVisits(trx, organizationId, shiftId) };
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
    for (const p of pending) await callDb(() => sql`SELECT app_shift_report_ensure(${p.shift_id}::uuid)`.execute(trx));
    const statusFilter = input.status === "PENDING" ? sql`AND r.status IN ('DRAFT', 'SUBMITTED', 'RETURNED')`
      : input.status ? sql`AND r.status = ${input.status}` : sql``;
    const rows = (await sql<ReportRow>`SELECT ${REPORT_COLUMNS} FROM shift_reports r LEFT JOIN users u ON u.id = r.approved_by_user_id
      WHERE r.organization_id = ${organizationId} AND r.status <> 'SUPERSEDED' ${statusFilter}
      ORDER BY (r.status = 'SUBMITTED') DESC, (r.content->'shift'->>'scheduledStart') DESC NULLS LAST, r.version DESC LIMIT 200`.execute(trx)).rows;
    return {
      reports: rows.map((r) => {
        const c = r.content as Json;
        return { id: r.id, shiftId: r.shift_id, status: r.status, version: r.version, generatedAt: iso(r.generated_at), approvedAt: iso(r.approved_at),
          recipientName: (c.recipient as Json)?.name ?? null, caregiverName: (c.caregiver as Json)?.name ?? null,
          scheduledStart: (c.shift as Json)?.scheduledStart ?? null, scheduledEnd: (c.shift as Json)?.scheduledEnd ?? null, totals: c.totals ?? null,
          submittedAt: iso(r.submitted_at), reviewDeadlineAt: iso(r.review_deadline_at), caregiverWindowExpired: windowExpired(r),
          hasCaregiverNote: r.caregiver_note !== null };
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

/** POST /shift-reports/:id/refresh: rebuild a DRAFT/RETURNED report from the records (e.g. an offline record that arrived later). */
export async function refreshShiftReport(userId: string, organizationId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    await lockReport(trx, organizationId, reportId);
    await callDb(() => sql`SELECT app_shift_report_refresh(${reportId}::uuid)`.execute(trx));
    const fresh = await lockReport(trx, organizationId, reportId);
    return { report: toReport(fresh, await historyOf(trx, reportId)) };
  });
}

export const returnSchema = z.object({ note: z.string().trim().min(1).max(1000) }).strict();

/** POST /shift-reports/:id/return: SUBMITTED -> RETURNED with a note, while the caregiver can still answer. */
export async function returnShiftReport(userId: string, organizationId: string, reportId: string, input: z.infer<typeof returnSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    await lockReport(trx, organizationId, reportId);
    await callDb(() => sql`SELECT app_shift_report_return(${reportId}::uuid, ${input.note})`.execute(trx));
    const fresh = await lockReport(trx, organizationId, reportId);
    return { report: toReport(fresh, await historyOf(trx, reportId)) };
  });
}

/** POST /shift-reports/:id/approve: DRAFT/SUBMITTED/RETURNED -> APPROVED with the family sections. Approved reports never change. */
export async function approveShiftReport(userId: string, organizationId: string, reportId: string, input: z.infer<typeof approveSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const r = await lockReport(trx, organizationId, reportId);
    if (r.status === "APPROVED" || r.status === "SUPERSEDED") throw new ShiftReportError("SHIFT_REPORT_ALREADY_APPROVED", 409);
    if (!["DRAFT", "SUBMITTED", "RETURNED"].includes(r.status)) throw new ShiftReportError("SHIFT_REPORT_NOT_DRAFT", 409);
    if (new Date(input.expectedGeneratedAt).getTime() !== new Date(r.generated_at).getTime()) throw new ShiftReportError("SHIFT_REPORT_CHANGED", 409);
    // Nobody approves the report of their own visit (the database guards it too).
    const own = await sql`SELECT 1 FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
      WHERE owm.id = ${r.organization_worker_membership_id} AND w.user_id = ${userId}`.execute(trx);
    if (own.rows[0]) throw new ShiftReportError("SHIFT_REPORT_SELF_APPROVAL", 403);
    const familySections: FamilySections = { ...FAMILY_SECTION_DEFAULTS, ...input.familySections } as FamilySections;
    await sql`UPDATE shift_reports SET status = 'APPROVED', approved_at = now(), approved_by_user_id = ${userId},
      family_sections = ${JSON.stringify(familySections)}::jsonb, agency_summary = ${input.agencySummary ?? null}
      WHERE id = ${reportId}`.execute(trx);
    await appendEvent(trx, organizationId, reportId, userId, "APPROVED", { familySections, summary: Boolean(input.agencySummary), fromStatus: r.status });
    const fresh = await lockReport(trx, organizationId, reportId);
    return { report: toReport(fresh, await historyOf(trx, reportId)) };
  });
}

// ------------------------------------------------------------------ who may review

export const reviewerGrantSchema = z.object({ membershipId: z.string().uuid() }).strict();

/** GET /shift-report-access: what the current user may do (used by the portal to show the screens). */
export async function myShiftReportAccess(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = (await sql<{ review: boolean; admin: boolean }>`SELECT app_can_review_shift_reports() AS review, app_is_shift_report_admin() AS admin`.execute(trx)).rows[0];
    return { canReview: Boolean(r?.review), canManageReviewers: Boolean(r?.admin) };
  });
}

/** GET /shift-report-reviewers: the agency's active supervisors and whether each is authorized (admins only). */
export async function listShiftReportReviewers(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertAdmin(trx);
    const rows = (await sql<{ membership_id: string; email: string; grant_id: string | null; granted_at: string | null; granted_by_email: string | null }>`
      SELECT om.id AS membership_id, u.email, g.id AS grant_id, g.granted_at, gu.email AS granted_by_email
      FROM organization_memberships om
      JOIN users u ON u.id = om.user_id
      JOIN user_roles ur ON ur.organization_membership_id = om.id
      JOIN roles r ON r.id = ur.role_id AND r.code = 'SUPERVISOR'
      LEFT JOIN shift_report_reviewers g ON g.organization_membership_id = om.id AND g.organization_id = om.organization_id AND g.revoked_at IS NULL
      LEFT JOIN users gu ON gu.id = g.granted_by_user_id
      WHERE om.organization_id = ${organizationId} AND om.status = 'active'
      ORDER BY u.email`.execute(trx)).rows;
    return { supervisors: rows.map((r) => ({ membershipId: r.membership_id, email: r.email, authorized: Boolean(r.grant_id),
      grantedAt: iso(r.granted_at), grantedBy: r.granted_by_email })) };
  });
}

async function activeSupervisor(trx: Trx, organizationId: string, membershipId: string) {
  const r = await sql`SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id JOIN roles ro ON ro.id = ur.role_id AND ro.code = 'SUPERVISOR'
    WHERE om.id = ${membershipId} AND om.organization_id = ${organizationId} AND om.status = 'active'`.execute(trx);
  return Boolean(r.rows[0]);
}

/** POST /shift-report-reviewers: an admin authorizes one of the agency's supervisors. Idempotent. */
export async function grantShiftReportReviewer(userId: string, organizationId: string, input: z.infer<typeof reviewerGrantSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertAdmin(trx);
    if (!(await activeSupervisor(trx, organizationId, input.membershipId))) throw new ShiftReportError("NOT_AN_ACTIVE_SUPERVISOR", 409);
    await sql`INSERT INTO shift_report_reviewers (organization_id, organization_membership_id, granted_by_user_id)
      VALUES (${organizationId}, ${input.membershipId}, ${userId})
      ON CONFLICT (organization_membership_id) WHERE revoked_at IS NULL DO NOTHING`.execute(trx);
    return { membershipId: input.membershipId, authorized: true };
  });
}

/** POST /shift-report-reviewers/:membershipId/revoke: the grant is kept with who and when it was revoked. */
export async function revokeShiftReportReviewer(userId: string, organizationId: string, membershipId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertAdmin(trx);
    await sql`UPDATE shift_report_reviewers SET revoked_at = now(), revoked_by_user_id = ${userId}
      WHERE organization_id = ${organizationId} AND organization_membership_id = ${membershipId} AND revoked_at IS NULL`.execute(trx);
    return { membershipId, authorized: false };
  });
}

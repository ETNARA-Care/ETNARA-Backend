import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { ShiftReportError, callDb } from "./shiftReports.service.js";

/**
 * Informe de Turno F2 (migration 128): the caregiver reviews the report of HER OWN
 * visit. Reading goes through RLS (shift_reports_own_visit_read: her own visits, while
 * her agency membership is active, also after the service ended). Writing goes through
 * guarded database functions: one final observation and «Enviar a revisión», only within
 * 24 h of the real end and only while DRAFT or RETURNED. She never edits the snapshot
 * (her original records), never approves and never deletes.
 */

type Json = Record<string, unknown>;
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

export const observationSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();

interface OwnRow {
  id: string; shift_id: string; status: string; version: number; content: Json; generated_at: string;
  review_deadline_at: string | null; caregiver_note: string | null; caregiver_note_at: string | null; submitted_at: string | null; approved_at: string | null;
}
const COLUMNS = sql`r.id, r.shift_id, r.status, r.version, r.content, r.generated_at, r.review_deadline_at,
  r.caregiver_note, r.caregiver_note_at, r.submitted_at, r.approved_at`;

function canEdit(r: OwnRow) {
  return (r.status === "DRAFT" || r.status === "RETURNED") && r.review_deadline_at !== null && new Date(r.review_deadline_at).getTime() > Date.now();
}

/** What the caregiver sees: her records and the report status. Not the family choices nor the agency summary. */
function toOwn(r: OwnRow) {
  return {
    id: r.id, shiftId: r.shift_id, status: r.status, version: r.version, content: r.content, generatedAt: iso(r.generated_at),
    reviewDeadlineAt: iso(r.review_deadline_at), caregiverNote: r.caregiver_note, caregiverNoteAt: iso(r.caregiver_note_at),
    submittedAt: iso(r.submitted_at), approvedAt: iso(r.approved_at), canEdit: canEdit(r),
  };
}

const SHOWN_TO_CAREGIVER = new Set(["GENERATED", "OBSERVATION_ADDED", "SUBMITTED", "RETURNED", "APPROVED"]);

/** GET /me/shift-reports: her own reports (newest first). */
export async function listMyShiftReports(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const rows = (await sql<OwnRow>`SELECT ${COLUMNS} FROM shift_reports r
      WHERE r.organization_id = ${organizationId} AND r.status <> 'SUPERSEDED' AND app_is_my_worker_membership(r.organization_worker_membership_id)
      ORDER BY (r.content->'shift'->>'scheduledStart') DESC NULLS LAST LIMIT 100`.execute(trx)).rows;
    return {
      reports: rows.map((r) => {
        const c = r.content as Json;
        return { id: r.id, status: r.status, recipientName: (c.recipient as Json)?.name ?? null,
          scheduledStart: (c.shift as Json)?.scheduledStart ?? null, scheduledEnd: (c.shift as Json)?.scheduledEnd ?? null,
          reviewDeadlineAt: iso(r.review_deadline_at), submittedAt: iso(r.submitted_at), canEdit: canEdit(r) };
      }),
    };
  });
}

async function readOwn(trx: Parameters<Parameters<typeof withTenantContext>[1]>[0], organizationId: string, reportId: string) {
  const r = (await sql<OwnRow>`SELECT ${COLUMNS} FROM shift_reports r
    WHERE r.id = ${reportId} AND r.organization_id = ${organizationId} AND app_is_my_worker_membership(r.organization_worker_membership_id)`.execute(trx)).rows[0];
  if (!r) throw new ShiftReportError("SHIFT_REPORT_NOT_FOUND", 404);
  const history = (await sql<{ event_type: string; created_at: string; note: string | null; mine: boolean }>`
    SELECT e.event_type, e.created_at, e.note, (e.actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) AS mine
    FROM shift_report_events e WHERE e.shift_report_id = ${reportId} ORDER BY e.created_at, e.id`.execute(trx)).rows
    .filter((e) => SHOWN_TO_CAREGIVER.has(e.event_type))
    // The agency's return note is for her; other notes are hers. Staff identities are not shown.
    .map((e) => ({ type: e.event_type, at: iso(e.created_at), note: e.event_type === "RETURNED" || e.event_type === "OBSERVATION_ADDED" ? e.note : null, byMe: Boolean(e.mine) }));
  return { report: { ...toOwn(r), history } };
}

/** GET /me/shift-reports/:id */
export async function getMyShiftReport(userId: string, organizationId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, (trx) => readOwn(trx, organizationId, reportId));
}

/** POST /me/shift-reports/:id/observation */
export async function setMyObservation(userId: string, organizationId: string, reportId: string, input: z.infer<typeof observationSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await callDb(() => sql`SELECT app_shift_report_set_observation(${reportId}::uuid, ${input.text})`.execute(trx));
    return readOwn(trx, organizationId, reportId);
  });
}

/** POST /me/shift-reports/:id/submit */
export async function submitMyShiftReport(userId: string, organizationId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await callDb(() => sql`SELECT app_shift_report_submit(${reportId}::uuid)`.execute(trx));
    return readOwn(trx, organizationId, reportId);
  });
}

// ------------------------------------------------------------------ background
const TICK_MS = 60_000;

/** Drafts appear on their own when a visit ends (agencies with SHIFT_REPORTS on). Counts only in logs. */
export async function generatePendingShiftReports(): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app_shift_reports_generate_pending() AS n`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

export function startShiftReportWorker(): () => void {
  const tick = async () => {
    try { await generatePendingShiftReports(); }
    catch (error) {
      const failure = error as { name?: string; code?: string };
      console.error("Shift report worker failed", { name: failure.name ?? "Error", code: failure.code ?? "UNKNOWN" });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";

export class TimesheetForbiddenError extends Error {
  constructor() {
    super("TIMESHEET_FORBIDDEN");
    this.name = "TimesheetForbiddenError";
  }
}

export class FinancialRateMembershipNotFoundError extends Error {
  constructor() {
    super("FINANCIAL_RATE_MEMBERSHIP_NOT_FOUND");
    this.name = "FinancialRateMembershipNotFoundError";
  }
}

export class TimesheetNotFoundError extends Error {
  constructor() {
    super("TIMESHEET_NOT_FOUND");
    this.name = "TimesheetNotFoundError";
  }
}

export class TimesheetAlreadyApprovedError extends Error {
  constructor() {
    super("TIMESHEET_ALREADY_APPROVED");
    this.name = "TimesheetAlreadyApprovedError";
  }
}

export class FinancialRateRequiredError extends Error {
  constructor() {
    super("FINANCIAL_RATE_REQUIRED");
    this.name = "FinancialRateRequiredError";
  }
}

export const financialRateSchema = z.object({
  payRateCents: z.number().int().min(0).max(100000),
  billRateCents: z.number().int().min(0).max(100000),
  currency: z.literal("USD").default("USD"),
});

export const timesheetFiltersSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["pending", "approved", "disputed"]).optional(),
}).refine((value) => value.dateFrom <= value.dateTo, { message: "INVALID_DATE_RANGE" });

export const timesheetReviewSchema = z.object({
  decision: z.enum(["approved", "disputed"]),
  approvedMinutes: z.number().int().min(1).max(2880).optional(),
  note: z.string().trim().max(1000).optional(),
}).superRefine((value, context) => {
  if (value.decision === "disputed" && !value.note) {
    context.addIssue({ code: "custom", message: "DISPUTE_NOTE_REQUIRED", path: ["note"] });
  }
});

interface FinancialRateRow {
  membership_id: string;
  display_name: string | null;
  internal_role: string;
  membership_status: string;
  pay_rate_cents: number | null;
  bill_rate_cents: number | null;
  currency: string | null;
  updated_at: string | null;
}

interface TimesheetRow {
  id: string;
  organization_id: string;
  shift_id: string;
  assignment_id: string;
  organization_worker_membership_id: string;
  care_recipient_id: string | null;
  worker_name: string | null;
  worker_role: string;
  recipient_name: string | null;
  scheduled_start: string;
  scheduled_end: string;
  check_in_at: string;
  check_out_at: string;
  recorded_minutes: number;
  approved_minutes: number | null;
  pay_rate_cents_snapshot: number | null;
  bill_rate_cents_snapshot: number | null;
  currency: string;
  pay_amount_cents: number | null;
  bill_amount_cents: number | null;
  status: "pending" | "approved" | "disputed";
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

async function assertManager(trx: unknown): Promise<void> {
  const result = await sql<{ is_manager: boolean }>`SELECT app_is_org_manager() AS is_manager`.execute(trx as never);
  if (!result.rows[0]?.is_manager) throw new TimesheetForbiddenError();
}

export async function recordTimesheetFromCheckout(
  trx: unknown,
  input: {
    actorUserId: string;
    organizationId: string;
    shiftId: string;
    membershipId: string;
    checkInAt: string;
    checkOutAt: string;
  }
): Promise<void> {
  await sql`
    SELECT app_record_timesheet_from_checkout(
      ${input.actorUserId},
      ${input.organizationId},
      ${input.shiftId},
      ${input.membershipId},
      ${input.checkInAt}::timestamptz,
      ${input.checkOutAt}::timestamptz
    )
  `.execute(trx as never);
}

export async function listFinancialRates(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<FinancialRateRow>`
      SELECT
        membership.id AS membership_id,
        worker.display_name,
        membership.internal_role,
        membership.status AS membership_status,
        rate.pay_rate_cents,
        rate.bill_rate_cents,
        rate.currency,
        rate.updated_at
      FROM organization_worker_memberships membership
      JOIN workers worker ON worker.id = membership.worker_id
      LEFT JOIN worker_financial_rates rate
        ON rate.organization_worker_membership_id = membership.id
      WHERE membership.organization_id = ${organizationId}
      ORDER BY (membership.status = 'active') DESC, worker.display_name NULLS LAST, membership.internal_role
    `.execute(trx);
    return result.rows;
  });
}

export async function upsertFinancialRate(
  userId: string,
  organizationId: string,
  membershipId: string,
  input: z.infer<typeof financialRateSchema>
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const membership = await sql<{ id: string }>`
      SELECT id FROM organization_worker_memberships
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!membership.rows[0]) throw new FinancialRateMembershipNotFoundError();

    const previous = await sql`
      SELECT pay_rate_cents, bill_rate_cents, currency
      FROM worker_financial_rates
      WHERE organization_worker_membership_id = ${membershipId}
    `.execute(trx);

    const saved = await sql<{
      organization_worker_membership_id: string;
      pay_rate_cents: number;
      bill_rate_cents: number;
      currency: string;
      updated_at: string;
    }>`
      INSERT INTO worker_financial_rates (
        organization_worker_membership_id, organization_id,
        pay_rate_cents, bill_rate_cents, currency,
        created_by_user_id, updated_by_user_id
      ) VALUES (
        ${membershipId}, ${organizationId},
        ${input.payRateCents}, ${input.billRateCents}, ${input.currency},
        ${userId}, ${userId}
      )
      ON CONFLICT (organization_worker_membership_id) DO UPDATE SET
        pay_rate_cents = EXCLUDED.pay_rate_cents,
        bill_rate_cents = EXCLUDED.bill_rate_cents,
        currency = EXCLUDED.currency,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
      RETURNING organization_worker_membership_id, pay_rate_cents, bill_rate_cents, currency, updated_at
    `.execute(trx);

    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id,
        action, entity_type, entity_id, previous_value, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId},
        'WORKER_FINANCIAL_RATE_CHANGED', 'organization_worker_membership', ${membershipId},
        ${JSON.stringify(previous.rows[0] ?? null)}::jsonb,
        ${JSON.stringify(saved.rows[0])}::jsonb
      )
    `.execute(trx);

    return saved.rows[0];
  });
}

export async function listTimesheets(
  userId: string,
  organizationId: string,
  filters: z.infer<typeof timesheetFiltersSchema>
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<TimesheetRow>`
      SELECT
        timesheet.id,
        timesheet.organization_id,
        timesheet.shift_id,
        timesheet.assignment_id,
        timesheet.organization_worker_membership_id,
        timesheet.care_recipient_id,
        worker.display_name AS worker_name,
        membership.internal_role AS worker_role,
        CASE WHEN recipient.id IS NULL THEN NULL
             ELSE trim(concat_ws(' ', recipient.first_name, recipient.last_name)) END AS recipient_name,
        shift.scheduled_start,
        shift.scheduled_end,
        timesheet.check_in_at,
        timesheet.check_out_at,
        timesheet.recorded_minutes,
        timesheet.approved_minutes,
        timesheet.pay_rate_cents_snapshot,
        timesheet.bill_rate_cents_snapshot,
        timesheet.currency,
        timesheet.pay_amount_cents,
        timesheet.bill_amount_cents,
        timesheet.status,
        timesheet.review_note,
        timesheet.reviewed_at,
        timesheet.created_at,
        timesheet.updated_at
      FROM timesheets timesheet
      JOIN organization_worker_memberships membership
        ON membership.id = timesheet.organization_worker_membership_id
      JOIN workers worker ON worker.id = membership.worker_id
      JOIN shifts shift ON shift.id = timesheet.shift_id
      LEFT JOIN care_recipients recipient ON recipient.id = timesheet.care_recipient_id
      WHERE timesheet.organization_id = ${organizationId}
        AND timesheet.check_in_at >= ${filters.dateFrom}::date
        AND timesheet.check_in_at < ${filters.dateTo}::date + interval '1 day'
        AND (${filters.status ?? null}::text IS NULL OR timesheet.status = ${filters.status ?? null}::text)
      ORDER BY timesheet.check_in_at DESC
    `.execute(trx);

    const rows = result.rows;
    return {
      timesheets: rows,
      summary: {
        recordedMinutes: rows.reduce((total, row) => total + Number(row.recorded_minutes), 0),
        approvedMinutes: rows.reduce((total, row) => total + Number(row.approved_minutes ?? 0), 0),
        pendingCount: rows.filter((row) => row.status === "pending").length,
        disputedCount: rows.filter((row) => row.status === "disputed").length,
        approvedPayCents: rows.reduce((total, row) => total + Number(row.pay_amount_cents ?? 0), 0),
        approvedBillCents: rows.reduce((total, row) => total + Number(row.bill_amount_cents ?? 0), 0),
      },
    };
  });
}

export async function reviewTimesheet(
  userId: string,
  organizationId: string,
  timesheetId: string,
  input: z.infer<typeof timesheetReviewSchema>
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const existing = await sql<{
      id: string;
      status: string;
      organization_worker_membership_id: string;
      recorded_minutes: number;
      pay_rate_cents_snapshot: number | null;
      bill_rate_cents_snapshot: number | null;
      currency: string;
      review_note: string | null;
      approved_minutes: number | null;
      pay_amount_cents: number | null;
      bill_amount_cents: number | null;
    }>`
      SELECT id, status, organization_worker_membership_id, recorded_minutes,
             pay_rate_cents_snapshot, bill_rate_cents_snapshot, currency,
             review_note, approved_minutes, pay_amount_cents, bill_amount_cents
      FROM timesheets
      WHERE id = ${timesheetId} AND organization_id = ${organizationId}
      FOR UPDATE
    `.execute(trx);
    const current = existing.rows[0];
    if (!current) throw new TimesheetNotFoundError();
    if (current.status === "approved") throw new TimesheetAlreadyApprovedError();

    let saved;
    if (input.decision === "disputed") {
      saved = await sql`
        UPDATE timesheets SET
          status = 'disputed',
          approved_minutes = NULL,
          pay_amount_cents = NULL,
          bill_amount_cents = NULL,
          review_note = ${input.note},
          reviewed_by_user_id = ${userId},
          reviewed_at = now(),
          updated_at = now()
        WHERE id = ${timesheetId} AND organization_id = ${organizationId}
        RETURNING *
      `.execute(trx);
    } else {
      const rate = await sql<{ pay_rate_cents: number | null; bill_rate_cents: number | null; currency: string | null }>`
        SELECT pay_rate_cents, bill_rate_cents, currency
        FROM worker_financial_rates
        WHERE organization_worker_membership_id = ${current.organization_worker_membership_id}
      `.execute(trx);
      const payRate = current.pay_rate_cents_snapshot ?? rate.rows[0]?.pay_rate_cents ?? null;
      const billRate = current.bill_rate_cents_snapshot ?? rate.rows[0]?.bill_rate_cents ?? null;
      if (payRate === null || billRate === null) throw new FinancialRateRequiredError();
      const minutes = input.approvedMinutes ?? Number(current.recorded_minutes);
      if (minutes !== Number(current.recorded_minutes) && !input.note) {
        throw new RangeError("ADJUSTMENT_NOTE_REQUIRED");
      }
      const payAmount = Math.round((minutes * Number(payRate)) / 60);
      const billAmount = Math.round((minutes * Number(billRate)) / 60);
      saved = await sql`
        UPDATE timesheets SET
          status = 'approved',
          approved_minutes = ${minutes},
          pay_rate_cents_snapshot = ${payRate},
          bill_rate_cents_snapshot = ${billRate},
          currency = ${current.currency ?? rate.rows[0]?.currency ?? "USD"},
          pay_amount_cents = ${payAmount},
          bill_amount_cents = ${billAmount},
          review_note = ${input.note ?? null},
          reviewed_by_user_id = ${userId},
          reviewed_at = now(),
          updated_at = now()
        WHERE id = ${timesheetId} AND organization_id = ${organizationId}
        RETURNING *
      `.execute(trx);
    }

    await sql`
      INSERT INTO audit_log (
        actor_user_id, organization_id, target_organization_id,
        action, entity_type, entity_id, previous_value, new_value
      ) VALUES (
        ${userId}, ${organizationId}, ${organizationId},
        ${input.decision === "approved" ? "TIMESHEET_APPROVED" : "TIMESHEET_DISPUTED"},
        'timesheet', ${timesheetId},
        ${JSON.stringify(current)}::jsonb,
        ${JSON.stringify(saved.rows[0])}::jsonb
      )
    `.execute(trx);

    return saved.rows[0];
  });
}

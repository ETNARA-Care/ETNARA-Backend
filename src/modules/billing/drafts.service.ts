import { sql } from "kysely";
import { z } from "zod";
import { AGENCY_TIME_ZONE, recordFinanceEvent, recordFinancialAudit } from "../finance/financeEvents.js";
import { resolveBillingRateForDate } from "../finance/finance.service.js";
import type { FinanceUnit } from "../finance/financeCalc.js";
import { BillingError, inBilling, mapDbError, requireAnyCapability, requireCapability, type Trx } from "./billing.service.js";
import { invoiceTotals, priceManual, priceShift, type LineResult, type SegmentRate, type TaxTreatment } from "./billingCalc.js";

/**
 * Facturación Premium F2.2 — drafts. Invoices are built from shifts with
 * APPROVED hours (D2), each shift reserved by one live draft only (D3), priced
 * per overnight segment with the rate of each date (D8), with manual and
 * discount lines that always carry a justification. Tax treatment is whatever
 * the agency configured per service — nothing is assumed (D5). Issuing does not
 * exist in F2.2: drafts list what would block it.
 *
 * Every rule is enforced again by the database (migration 124: RLS by billing
 * capability, guards, unique live reservation).
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reason = z.string().trim().min(3).max(300);
const version = z.number().int().min(1);
export const INACTIVE_DAYS = 14; // decision 25-oct: only marked, never released automatically
export const TOLERANCE_MINUTES = 15; // decision 25-oct: warnings only

export const draftCreateSchema = z.object({ billingClientId: uuid, periodFrom: isoDate, periodTo: isoDate, notes: z.string().trim().max(1000).optional() });
export const draftUpdateSchema = z.object({ expectedVersion: version, periodFrom: isoDate.optional(), periodTo: isoDate.optional(), notes: z.string().trim().max(1000).nullable().optional() });
export const shiftLinesSchema = z.object({ expectedVersion: version, shiftIds: z.array(uuid).min(1).max(100) });
export const manualLineSchema = z.object({
  expectedVersion: version,
  kind: z.enum(["manual", "discount"]),
  description: z.string().trim().min(2).max(300),
  justification: z.string().trim().min(3).max(500),
  serviceId: uuid.nullable().optional(),
  careRecipientId: uuid.nullable().optional(),
  serviceDate: isoDate,
  quantityHundredths: z.number().int().min(1).max(100000),
  unitPriceCents: z.number().int().min(0).max(10_000_000),
  taxTreatment: z.enum(["taxable", "exempt", "pending"]),
  taxRateBasisPoints: z.number().int().min(1).max(5000).nullable().optional(),
  taxLegalBasis: z.string().trim().min(3).max(300).nullable().optional(),
});
export const removeLineSchema = z.object({ expectedVersion: version, reason: reason.optional() });
export const versionOnlySchema = z.object({ expectedVersion: version });
export const discardSchema = z.object({ expectedVersion: version, reason });
export const eligibleQuerySchema = z.object({ billingClientId: uuid, from: isoDate, to: isoDate });
export const taxSetSchema = z.object({
  serviceId: uuid,
  treatment: z.enum(["taxable", "exempt", "pending"]),
  rateBasisPoints: z.number().int().min(1).max(5000).nullable().optional(),
  legalBasis: z.string().trim().min(3).max(300).nullable().optional(),
  validationNote: z.string().trim().max(300).nullable().optional(),
  effectiveFrom: isoDate,
});

const KNOWN: Record<string, number> = {
  DRAFT_CHANGED: 409, INVOICE_NOT_EDITABLE: 409, LINE_IMMUTABLE: 409, CLAIM_IMMUTABLE: 409, CLAIM_LINE_MISMATCH: 409,
  TAX_TREATMENT_IMMUTABLE: 409, BILLING_NO_DELETE: 409, INVOICE_IDENTITY_IMMUTABLE: 409,
};
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof BillingError) throw error;
    const e = error as { code?: string; message?: string; constraint?: string };
    const hit = Object.keys(KNOWN).find((k) => e?.message?.includes(k));
    if (hit) throw new BillingError(hit, KNOWN[hit]);
    if (e?.code === "23505" && e.constraint === "idx_invoice_shift_claims_live") throw new BillingError("SHIFT_ALREADY_RESERVED", 409);
    if (e?.code === "23505" && e.constraint === "finance_service_tax_service_id_effective_from_key") throw new BillingError("TAX_TREATMENT_DATE_EXISTS", 409);
    if (e?.code === "23514" || e?.code === "23503") throw new BillingError("BILLING_INVALID_DATA", 409);
    return mapDbError(error);
  }
}
const event = async (trx: Trx, organizationId: string, userId: string, action: string, entityType: string, entityId: string, newValue?: unknown, previousValue?: unknown) => {
  await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action, entityType, entityId, newValue, previousValue });
  await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action, entityType, entityId });
};

// ---------------------------------------------------------------------------
// Tax treatment (D5)

interface TaxRow { treatment: TaxTreatment; rate_basis_points: number | null; legal_basis: string | null; effective_from: string }
async function taxFor(trx: Trx, organizationId: string, serviceId: string | null, date: string): Promise<TaxRow> {
  if (!serviceId) return { treatment: "pending", rate_basis_points: null, legal_basis: null, effective_from: date };
  const row = (await sql<TaxRow>`
    SELECT treatment, rate_basis_points, legal_basis, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
    FROM finance_service_tax WHERE organization_id = ${organizationId} AND service_id = ${serviceId} AND effective_from <= ${date}::date
    ORDER BY effective_from DESC LIMIT 1`.execute(trx)).rows[0];
  return row ?? { treatment: "pending", rate_basis_points: null, legal_basis: null, effective_from: date };
}

export async function listTax(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "draft", "manage"]);
    const today = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${AGENCY_TIME_ZONE})::date, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d;
    const services = (await sql<{ id: string; name: string; unit: string; active: boolean }>`
      SELECT id, name, unit, active FROM finance_services WHERE organization_id = ${organizationId} ORDER BY active DESC, name`.execute(trx)).rows;
    const history = (await sql<{ id: string; service_id: string; treatment: TaxTreatment; rate_basis_points: number | null; legal_basis: string | null; validation_note: string | null; effective_from: string; created_at: string; created_by_email: string | null }>`
      SELECT t.id, t.service_id, t.treatment, t.rate_basis_points, t.legal_basis, t.validation_note, to_char(t.effective_from, 'YYYY-MM-DD') AS effective_from,
             t.created_at, u.email AS created_by_email
      FROM finance_service_tax t LEFT JOIN users u ON u.id = t.created_by_user_id
      WHERE t.organization_id = ${organizationId} ORDER BY t.effective_from DESC, t.created_at DESC`.execute(trx)).rows;
    return {
      today,
      services: services.map((s) => {
        const versions = history.filter((h) => h.service_id === s.id);
        const current = versions.find((h) => h.effective_from <= today) ?? null;
        return { ...s, current: current ?? { treatment: "pending" as TaxTreatment, rate_basis_points: null, legal_basis: null, effective_from: null }, versions };
      }),
    };
  }));
}

export async function setTax(userId: string, organizationId: string, input: z.infer<typeof taxSetSchema>) {
  if (input.treatment === "taxable" && !input.rateBasisPoints) throw new BillingError("TAX_RATE_REQUIRED", 400);
  if (input.treatment === "exempt" && !input.legalBasis) throw new BillingError("TAX_LEGAL_BASIS_REQUIRED", 400);
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "manage");
    const row = (await sql<{ id: string }>`
      INSERT INTO finance_service_tax (organization_id, service_id, treatment, rate_basis_points, legal_basis, validation_note, effective_from, created_by_user_id)
      VALUES (${organizationId}, ${input.serviceId}, ${input.treatment},
              ${input.treatment === "taxable" ? input.rateBasisPoints ?? null : null},
              ${input.treatment === "exempt" ? input.legalBasis ?? null : null},
              ${input.validationNote ?? null}, ${input.effectiveFrom}::date, ${userId})
      RETURNING id`.execute(trx)).rows[0];
    await event(trx, organizationId, userId, "FINANCE_BILLING_TAX_TREATMENT_SET", "finance_service_tax", row.id, input);
    return row;
  }));
}

// ---------------------------------------------------------------------------
// Eligible shifts (D2: approved hours only)

interface ShiftRow {
  id: string; care_recipient_id: string | null; recipient_name: string | null; status: string; service_date: string;
  scheduled_start: string; scheduled_end: string; service_id: string | null; service_name: string | null; unit: FinanceUnit | null;
  client_id: string | null; caregiver_name: string | null;
  approved_count: number; open_count: number; check_in_at: string | null; check_out_at: string | null; approved_minutes: number | null;
}

async function shiftRows(trx: Trx, organizationId: string, where: { clientId: string; from: string; to: string } | { shiftIds: string[] }) {
  const filter = "shiftIds" in where
    ? sql`s.id = ANY (${where.shiftIds}::uuid[])`
    : sql`(s.scheduled_start AT TIME ZONE ${AGENCY_TIME_ZONE})::date BETWEEN ${where.from}::date AND ${where.to}::date
          AND COALESCE(ft.billing_client_id, pc.billing_client_id) = ${where.clientId}`;
  return (await sql<ShiftRow>`
    SELECT s.id, s.care_recipient_id, NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '') AS recipient_name, s.status::text AS status,
      to_char((s.scheduled_start AT TIME ZONE ${AGENCY_TIME_ZONE})::date, 'YYYY-MM-DD') AS service_date,
      s.scheduled_start, s.scheduled_end,
      COALESCE(ft.service_id, d.service_id) AS service_id, fs.name AS service_name, fs.unit AS unit,
      COALESCE(ft.billing_client_id, pc.billing_client_id) AS client_id,
      ts.caregiver_name, COALESCE(ts.approved_count, 0) AS approved_count, COALESCE(ts.open_count, 0) AS open_count,
      ts.check_in_at, ts.check_out_at, ts.approved_minutes
    FROM shifts s
    LEFT JOIN care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
    LEFT JOIN shift_finance_terms ft ON ft.shift_id = s.id
    LEFT JOIN recipient_finance_defaults d ON d.care_recipient_id = s.care_recipient_id
    LEFT JOIN billing_client_recipients pc ON pc.care_recipient_id = s.care_recipient_id AND pc.is_primary
    LEFT JOIN finance_services fs ON fs.id = COALESCE(ft.service_id, d.service_id) AND fs.organization_id = s.organization_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE t.status = 'approved')::int AS approved_count,
             count(*) FILTER (WHERE t.status <> 'approved')::int AS open_count,
             min(t.check_in_at) FILTER (WHERE t.status = 'approved') AS check_in_at,
             max(t.check_out_at) FILTER (WHERE t.status = 'approved') AS check_out_at,
             sum(t.approved_minutes) FILTER (WHERE t.status = 'approved')::int AS approved_minutes,
             string_agg(DISTINCT w.display_name, ', ') AS caregiver_name
      FROM timesheets t
      LEFT JOIN organization_worker_memberships m ON m.id = t.organization_worker_membership_id
      LEFT JOIN workers w ON w.id = m.worker_id
      WHERE t.shift_id = s.id AND t.organization_id = s.organization_id) ts ON true
    WHERE s.organization_id = ${organizationId} AND ${filter}
    ORDER BY s.scheduled_start`.execute(trx)).rows;
}

interface Priced { line: LineResult | null; exceptions: string[]; tax: TaxRow }
async function priceRow(trx: Trx, organizationId: string, row: ShiftRow, clientId: string): Promise<Priced> {
  const exceptions: string[] = [];
  if (row.status === "cancelled") exceptions.push("SHIFT_CANCELLED");
  if (row.approved_count === 0) exceptions.push("HOURS_NOT_APPROVED");
  if (row.approved_count > 1 || row.open_count > 0) exceptions.push(row.approved_count > 1 ? "MULTIPLE_TIMESHEETS" : "HOURS_NOT_APPROVED");
  if (!row.service_id) exceptions.push("NO_SERVICE");
  const tax = await taxFor(trx, organizationId, row.service_id, row.service_date);
  if (exceptions.length || !row.service_id || !row.unit || !row.check_in_at || !row.approved_minutes) return { line: null, exceptions: [...new Set(exceptions)], tax };
  const cache = new Map<string, { rate: SegmentRate | null }>();
  for (const date of new Set(prDatesFor(row.check_in_at, row.approved_minutes))) {
    const r = await resolveBillingRateForDate(trx, organizationId, row.service_id, clientId, date);
    cache.set(date, {
      rate: r.rate ? {
        rateId: r.rate.rateId, amountCents: r.rate.amountCents, source: r.rate.source === "client" ? "client" : "general", dayType: r.rate.dayType,
        holiday: r.holiday, minMinutes: r.rate.rules.min_minutes, roundingMinutes: r.rate.rules.rounding_minutes,
        halfDayPolicy: r.rate.rules.half_day_policy, halfDayAmountCents: r.rate.rules.half_day_amount_cents,
      } : null,
    });
  }
  const line = priceShift(row.unit, new Date(row.check_in_at).toISOString(), row.approved_minutes, (d) => cache.get(d)?.rate ?? null, { toleranceMinutes: TOLERANCE_MINUTES });
  return { line, exceptions: line.reviewReasons, tax };
}
function prDatesFor(startIso: string, minutes: number): string[] {
  const start = Date.parse(startIso);
  const out: string[] = [];
  for (let t = start; t < start + minutes * 60_000; t += 30 * 60_000) out.push(new Intl.DateTimeFormat("en-CA", { timeZone: AGENCY_TIME_ZONE }).format(new Date(t)));
  out.push(new Intl.DateTimeFormat("en-CA", { timeZone: AGENCY_TIME_ZONE }).format(new Date(start + minutes * 60_000 - 1)));
  return out;
}

export async function eligibleShifts(userId: string, organizationId: string, q: z.infer<typeof eligibleQuerySchema>) {
  if (q.to < q.from) throw new BillingError("INVALID_PERIOD", 400);
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const rows = await shiftRows(trx, organizationId, { clientId: q.billingClientId, from: q.from, to: q.to });
    const claims = rows.length ? (await sql<{ shift_id: string; invoice_id: string; claimed_by_email: string; claimed_at: string }>`
      SELECT * FROM app_billing_live_claims(${organizationId}::uuid, ${rows.map((r) => r.id)}::uuid[])`.execute(trx)).rows : [];
    const out = [];
    for (const r of rows) {
      const claim = claims.find((c) => c.shift_id === r.id) ?? null;
      const priced = await priceRow(trx, organizationId, r, q.billingClientId);
      out.push({
        shiftId: r.id, serviceDate: r.service_date, recipientName: r.recipient_name, caregiverName: r.caregiver_name,
        serviceId: r.service_id, serviceName: r.service_name, unit: r.unit,
        realStart: r.check_in_at, realEnd: r.check_out_at, approvedMinutes: r.approved_minutes,
        reservedBy: claim ? { invoiceId: claim.invoice_id, email: claim.claimed_by_email, at: claim.claimed_at } : null,
        exceptions: priced.exceptions, warnings: priced.line?.warnings ?? [],
        amountCents: priced.line?.amountCents ?? null, segments: priced.line?.segments ?? [],
        taxTreatment: priced.tax.treatment,
        // Diseño v2 §7/§14: a line that needs a decision (partial day, missing rate) can be added; it is
        // flagged and blocks issuing (NEEDS_REVIEW) until the agency resolves it and recalculates.
        selectable: !claim && priced.line !== null,
      });
    }
    return { shifts: out };
  }));
}

// ---------------------------------------------------------------------------
// Drafts

async function lockDraft(trx: Trx, organizationId: string, invoiceId: string, expectedVersion: number) {
  const row = (await sql<{ id: string; status: string; row_version: number; billing_client_id: string; period_from: string; period_to: string; updated_at: string }>`
    SELECT id, status, row_version, billing_client_id, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to, updated_at
    FROM invoices WHERE id = ${invoiceId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
  if (!row) throw new BillingError("INVOICE_NOT_FOUND", 404);
  if (row.status !== "draft") throw new BillingError("INVOICE_NOT_EDITABLE", 409);
  if (row.row_version !== expectedVersion) throw new BillingError("DRAFT_CHANGED", 409);
  return row;
}
async function touch(trx: Trx, invoiceId: string, userId: string) {
  await sql`UPDATE invoices SET row_version = row_version + 1, updated_by_user_id = ${userId} WHERE id = ${invoiceId}`.execute(trx);
}

export async function createDraft(userId: string, organizationId: string, input: z.infer<typeof draftCreateSchema>) {
  if (input.periodTo < input.periodFrom) throw new BillingError("INVALID_PERIOD", 400);
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const client = (await sql<{ full_name: string; active: boolean }>`
      SELECT full_name, active FROM billing_clients WHERE id = ${input.billingClientId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!client) throw new BillingError("CLIENT_NOT_FOUND", 404);
    if (!client.active) throw new BillingError("CLIENT_INACTIVE", 409);
    const row = (await sql<{ id: string }>`
      INSERT INTO invoices (organization_id, billing_client_id, client_name, period_from, period_to, notes, created_by_user_id, updated_by_user_id)
      VALUES (${organizationId}, ${input.billingClientId}, ${client.full_name}, ${input.periodFrom}::date, ${input.periodTo}::date, ${input.notes || null}, ${userId}, ${userId})
      RETURNING id`.execute(trx)).rows[0];
    await event(trx, organizationId, userId, "FINANCE_BILLING_DRAFT_CREATED", "invoice", row.id, { billingClientId: input.billingClientId, periodFrom: input.periodFrom, periodTo: input.periodTo });
    return { id: row.id };
  }));
}

export async function updateDraft(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof draftUpdateSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const before = await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    const from = input.periodFrom ?? before.period_from;
    const to = input.periodTo ?? before.period_to;
    if (to < from) throw new BillingError("INVALID_PERIOD", 400);
    const outside = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = ${invoiceId} AND removed_at IS NULL AND kind = 'shift'
        AND (service_date < ${from}::date OR service_date > ${to}::date)`.execute(trx)).rows[0].n;
    if (outside > 0) throw new BillingError("LINES_OUTSIDE_PERIOD", 409);
    await sql`UPDATE invoices SET period_from = ${from}::date, period_to = ${to}::date,
      notes = ${input.notes === undefined ? sql`notes` : input.notes || null}, row_version = row_version + 1, updated_by_user_id = ${userId}
      WHERE id = ${invoiceId}`.execute(trx);
    await event(trx, organizationId, userId, "FINANCE_BILLING_DRAFT_UPDATED", "invoice", invoiceId, { periodFrom: from, periodTo: to }, { periodFrom: before.period_from, periodTo: before.period_to });
  }));
}

async function insertShiftLine(trx: Trx, organizationId: string, userId: string, invoiceId: string, row: ShiftRow, priced: Priced, position: number) {
  const line = priced.line!;
  const tax = priced.tax;
  const desc = `${row.service_name ?? "Servicio"}${row.recipient_name ? ` · ${row.recipient_name}` : ""}`;
  const inserted = (await sql<{ id: string }>`
    INSERT INTO invoice_lines (organization_id, invoice_id, kind, shift_id, care_recipient_id, recipient_name, service_id, description,
      service_date, real_start, real_end, approved_minutes, unit, quantity_hundredths, unit_price_cents, amount_cents,
      tax_treatment, tax_rate_basis_points, tax_legal_basis, needs_review, review_reasons, warnings, position, created_by_user_id)
    VALUES (${organizationId}, ${invoiceId}, 'shift', ${row.id}, ${row.care_recipient_id}, ${row.recipient_name}, ${row.service_id}, ${desc},
      ${row.service_date}::date, ${row.check_in_at}, ${row.check_out_at}, ${row.approved_minutes}, ${row.unit}, ${line.quantityHundredths},
      ${line.unitPriceCents}, ${line.amountCents}, ${tax.treatment}, ${tax.rate_basis_points}, ${tax.legal_basis},
      ${line.needsReview}, ${line.reviewReasons}::text[], ${JSON.stringify(line.warnings)}::jsonb, ${position}, ${userId})
    RETURNING id`.execute(trx)).rows[0];
  for (const s of line.segments) {
    await sql`
      INSERT INTO invoice_line_segments (organization_id, line_id, segment_date, starts_at, ends_at, minutes, billable_minutes,
        rate_id, rate_source, day_type, holiday_name, unit_price_cents, amount_cents, rules)
      VALUES (${organizationId}, ${inserted.id}, ${s.date}::date, ${s.startsAt}, ${s.endsAt}, ${s.minutes}, ${s.billableMinutes},
        ${s.rate?.rateId ?? null}, ${s.rate?.source ?? null}, ${s.rate?.dayType ?? null}, ${s.rate?.holiday ?? null}, ${s.rate?.amountCents ?? null},
        ${s.amountCents}, ${JSON.stringify(s.rate ? { minMinutes: s.rate.minMinutes, roundingMinutes: s.rate.roundingMinutes, halfDayPolicy: s.rate.halfDayPolicy, halfDayAmountCents: s.rate.halfDayAmountCents } : {})}::jsonb)`.execute(trx);
  }
  return inserted.id;
}

async function claim(trx: Trx, organizationId: string, userId: string, invoiceId: string, shiftId: string, lineId: string) {
  try {
    await sql`SAVEPOINT claim_shift`.execute(trx);
    await sql`INSERT INTO invoice_shift_claims (organization_id, shift_id, invoice_id, line_id, claimed_by_user_id)
      VALUES (${organizationId}, ${shiftId}, ${invoiceId}, ${lineId}, ${userId})`.execute(trx);
    await sql`RELEASE SAVEPOINT claim_shift`.execute(trx);
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if (e?.code === "23505" && e.constraint === "idx_invoice_shift_claims_live") {
      await sql`ROLLBACK TO SAVEPOINT claim_shift`.execute(trx);
      const holder = (await sql<{ invoice_id: string; claimed_by_email: string }>`
        SELECT invoice_id, claimed_by_email FROM app_billing_live_claims(${organizationId}::uuid, ARRAY[${shiftId}]::uuid[])`.execute(trx)).rows[0];
      const err = new BillingError("SHIFT_ALREADY_RESERVED", 409) as BillingError & { detail?: unknown };
      err.detail = { shiftId, invoiceId: holder?.invoice_id ?? null, reservedBy: holder?.claimed_by_email ?? null };
      throw err;
    }
    throw error;
  }
  await event(trx, organizationId, userId, "FINANCE_BILLING_SHIFT_RESERVED", "shift", shiftId, { invoiceId, lineId });
}

export async function addShiftLines(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof shiftLinesSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const draft = await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    const ids = [...new Set(input.shiftIds)];
    const rows = await shiftRows(trx, organizationId, { shiftIds: ids });
    if (rows.length !== ids.length) throw new BillingError("SHIFT_NOT_FOUND", 404);
    let position = (await sql<{ n: number }>`SELECT COALESCE(max(position), 0)::int AS n FROM invoice_lines WHERE invoice_id = ${invoiceId}`.execute(trx)).rows[0].n;
    const added: string[] = [];
    for (const r of rows) {
      if (r.client_id !== draft.billing_client_id) throw Object.assign(new BillingError("SHIFT_OTHER_CLIENT", 409), { detail: { shiftId: r.id } });
      if (r.service_date < draft.period_from || r.service_date > draft.period_to) throw Object.assign(new BillingError("SHIFT_OUTSIDE_PERIOD", 409), { detail: { shiftId: r.id } });
      const priced = await priceRow(trx, organizationId, r, draft.billing_client_id);
      // Unapproved hours, no service or several timesheets: no line at all. A line that needs a decision
      // is added flagged (needs_review) and blocks issuing (diseño v2 §7/§14).
      if (!priced.line) throw Object.assign(new BillingError("SHIFT_NOT_BILLABLE", 409), { detail: { shiftId: r.id, exceptions: priced.exceptions } });
      const lineId = await insertShiftLine(trx, organizationId, userId, invoiceId, r, priced, ++position);
      await claim(trx, organizationId, userId, invoiceId, r.id, lineId);
      await event(trx, organizationId, userId, "FINANCE_BILLING_LINE_ADDED", "invoice_line", lineId, { invoiceId, kind: "shift", shiftId: r.id, amountCents: priced.line.amountCents });
      added.push(lineId);
    }
    await touch(trx, invoiceId, userId);
    return { added };
  }));
}

export async function addManualLine(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof manualLineSchema>) {
  if (input.taxTreatment === "taxable" && !input.taxRateBasisPoints) throw new BillingError("TAX_RATE_REQUIRED", 400);
  if (input.taxTreatment === "exempt" && !input.taxLegalBasis) throw new BillingError("TAX_LEGAL_BASIS_REQUIRED", 400);
  if (input.serviceId && !input.careRecipientId) throw new BillingError("RECIPIENT_REQUIRED_WITH_SERVICE", 400);
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const draft = await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    const warnings: { code: string }[] = [];
    let recipientName: string | null = null;
    if (input.careRecipientId) {
      const link = (await sql<{ name: string | null }>`
        SELECT NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '') AS name FROM billing_client_recipients l
        JOIN care_recipients cr ON cr.id = l.care_recipient_id AND cr.organization_id = l.organization_id
        WHERE l.billing_client_id = ${draft.billing_client_id} AND l.care_recipient_id = ${input.careRecipientId} AND l.organization_id = ${organizationId}`.execute(trx)).rows[0];
      if (!link) throw new BillingError("RECIPIENT_NOT_OF_CLIENT", 409);
      recipientName = link.name;
    }
    if (input.serviceId) {
      const svc = await sql`SELECT 1 FROM finance_services WHERE id = ${input.serviceId} AND organization_id = ${organizationId}`.execute(trx);
      if (!svc.rows[0]) throw new BillingError("SERVICE_NOT_FOUND", 404);
    }
    // D2 anti-evasion: a manual line can never stand in for a shift that is reserved.
    if (input.kind === "manual" && input.serviceId && input.careRecipientId) {
      const dup = (await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM invoice_shift_claims c
        JOIN invoice_lines l ON l.id = c.line_id
        WHERE c.organization_id = ${organizationId} AND c.released_at IS NULL
          AND l.care_recipient_id = ${input.careRecipientId} AND l.service_id = ${input.serviceId} AND l.service_date = ${input.serviceDate}::date`.execute(trx)).rows[0].n;
      if (dup > 0) throw new BillingError("MANUAL_LINE_DUPLICATES_SHIFT", 409);
      const pending = (await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM shifts s LEFT JOIN timesheets t ON t.shift_id = s.id AND t.status = 'approved'
        WHERE s.organization_id = ${organizationId} AND s.care_recipient_id = ${input.careRecipientId} AND s.status::text <> 'cancelled'
          AND (s.scheduled_start AT TIME ZONE ${AGENCY_TIME_ZONE})::date = ${input.serviceDate}::date AND t.id IS NULL`.execute(trx)).rows[0].n;
      if (pending > 0) warnings.push({ code: "UNAPPROVED_SHIFT_SAME_DAY" });
    }
    const gross = priceManual(input.quantityHundredths, input.unitPriceCents);
    const amount = input.kind === "discount" ? -gross : gross;
    const position = (await sql<{ n: number }>`SELECT COALESCE(max(position), 0)::int + 1 AS n FROM invoice_lines WHERE invoice_id = ${invoiceId}`.execute(trx)).rows[0].n;
    const row = (await sql<{ id: string }>`
      INSERT INTO invoice_lines (organization_id, invoice_id, kind, care_recipient_id, recipient_name, service_id, description, justification,
        service_date, unit, quantity_hundredths, unit_price_cents, amount_cents, tax_treatment, tax_rate_basis_points, tax_legal_basis,
        warnings, position, created_by_user_id)
      VALUES (${organizationId}, ${invoiceId}, ${input.kind}, ${input.careRecipientId ?? null}, ${recipientName}, ${input.serviceId ?? null},
        ${input.description}, ${input.justification}, ${input.serviceDate}::date, 'unit', ${input.quantityHundredths}, ${input.unitPriceCents}, ${amount},
        ${input.taxTreatment}, ${input.taxTreatment === "taxable" ? input.taxRateBasisPoints ?? null : null},
        ${input.taxTreatment === "exempt" ? input.taxLegalBasis ?? null : null}, ${JSON.stringify(warnings)}::jsonb, ${position}, ${userId})
      RETURNING id`.execute(trx)).rows[0];
    await event(trx, organizationId, userId, "FINANCE_BILLING_LINE_ADDED", "invoice_line", row.id, { invoiceId, kind: input.kind, amountCents: amount, justification: input.justification });
    await touch(trx, invoiceId, userId);
    return { id: row.id, warnings };
  }));
}

async function releaseClaims(trx: Trx, organizationId: string, userId: string, where: { invoiceId: string } | { lineId: string }, kind: "line_removed" | "draft_discarded" | "abandoned_recovery", why: string | null) {
  const filter = "lineId" in where ? sql`line_id = ${where.lineId}` : sql`invoice_id = ${where.invoiceId}`;
  const released = (await sql<{ shift_id: string; invoice_id: string }>`
    UPDATE invoice_shift_claims SET released_at = now(), released_by_user_id = ${userId}, release_reason = ${why}, release_kind = ${kind}
    WHERE organization_id = ${organizationId} AND released_at IS NULL AND ${filter}
    RETURNING shift_id, invoice_id`.execute(trx)).rows;
  for (const r of released) await event(trx, organizationId, userId, "FINANCE_BILLING_RESERVATION_RELEASED", "shift", r.shift_id, { invoiceId: r.invoice_id, kind, reason: why });
  return released.length;
}

export async function removeLine(userId: string, organizationId: string, invoiceId: string, lineId: string, input: z.infer<typeof removeLineSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    const line = (await sql<{ id: string; kind: string; amount_cents: number }>`
      UPDATE invoice_lines SET removed_at = now(), removed_by_user_id = ${userId}, remove_reason = ${input.reason ?? null}
      WHERE id = ${lineId} AND invoice_id = ${invoiceId} AND organization_id = ${organizationId} AND removed_at IS NULL
      RETURNING id, kind, amount_cents`.execute(trx)).rows[0];
    if (!line) throw new BillingError("LINE_NOT_FOUND", 404);
    const released = line.kind === "shift" ? await releaseClaims(trx, organizationId, userId, { lineId }, "line_removed", input.reason ?? null) : 0;
    await event(trx, organizationId, userId, "FINANCE_BILLING_LINE_REMOVED", "invoice_line", lineId, { invoiceId, reason: input.reason ?? null, released }, { amountCents: line.amount_cents });
    await touch(trx, invoiceId, userId);
    return { released };
  }));
}

export async function recalculate(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof versionOnlySchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const draft = await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    const lines = (await sql<{ id: string; shift_id: string; amount_cents: number; position: number }>`
      SELECT id, shift_id, amount_cents, position FROM invoice_lines WHERE invoice_id = ${invoiceId} AND kind = 'shift' AND removed_at IS NULL ORDER BY position`.execute(trx)).rows;
    let changed = 0;
    for (const l of lines) {
      const [row] = await shiftRows(trx, organizationId, { shiftIds: [l.shift_id] });
      const priced = await priceRow(trx, organizationId, row, draft.billing_client_id);
      if (!priced.line) continue; // no longer billable (e.g. hours reopened): flagged as rate changed, the agency removes it
      const current = await storedPricing(trx, l.id);
      if (current === fingerprint(priced)) continue;
      await sql`UPDATE invoice_lines SET removed_at = now(), removed_by_user_id = ${userId}, remove_reason = 'Recalculada' WHERE id = ${l.id}`.execute(trx);
      await releaseClaims(trx, organizationId, userId, { lineId: l.id }, "line_removed", "Recalculada");
      const newId = await insertShiftLine(trx, organizationId, userId, invoiceId, row, priced, l.position);
      await claim(trx, organizationId, userId, invoiceId, row.id, newId);
      await event(trx, organizationId, userId, "FINANCE_BILLING_LINE_RECALCULATED", "invoice_line", newId, { invoiceId, replaces: l.id, amountCents: priced.line.amountCents }, { amountCents: l.amount_cents });
      changed++;
    }
    await touch(trx, invoiceId, userId);
    return { changed };
  }));
}

async function storedPricing(trx: Trx, lineId: string): Promise<string> {
  const r = (await sql<{ amount_cents: number; quantity_hundredths: number; tax_treatment: string; tax_rate_basis_points: number | null; segs: string }>`
    SELECT l.amount_cents, l.quantity_hundredths, l.tax_treatment, l.tax_rate_basis_points,
      COALESCE(string_agg(concat_ws(':', s.segment_date, s.minutes, s.billable_minutes, s.rate_id, s.amount_cents), '|' ORDER BY s.starts_at), '') AS segs
    FROM invoice_lines l LEFT JOIN invoice_line_segments s ON s.line_id = l.id
    WHERE l.id = ${lineId} GROUP BY l.id`.execute(trx)).rows[0];
  return [r.amount_cents, r.quantity_hundredths, r.tax_treatment, r.tax_rate_basis_points ?? "", r.segs].join("#");
}
function fingerprint(p: Priced): string {
  const l = p.line!;
  return [l.amountCents, l.quantityHundredths, p.tax.treatment, p.tax.rate_basis_points ?? "",
    l.segments.map((s) => [s.date, s.minutes, s.billableMinutes, s.rate?.rateId ?? "", s.amountCents].join(":")).join("|")].join("#");
}

async function closeDraft(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof discardSchema>, kind: "discarded" | "abandoned_recovery") {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const draft = await lockDraft(trx, organizationId, invoiceId, input.expectedVersion);
    if (kind === "abandoned_recovery") {
      const inactive = (await sql<{ ok: boolean }>`SELECT ${draft.updated_at}::timestamptz <= now() - make_interval(days => ${INACTIVE_DAYS}) AS ok`.execute(trx)).rows[0].ok;
      if (!inactive) throw new BillingError("DRAFT_NOT_INACTIVE", 409);
    }
    const released = await releaseClaims(trx, organizationId, userId, { invoiceId }, kind === "discarded" ? "draft_discarded" : "abandoned_recovery", input.reason);
    await sql`UPDATE invoices SET status = 'discarded', discarded_at = now(), discarded_by_user_id = ${userId}, discard_reason = ${input.reason},
      discard_kind = ${kind}, row_version = row_version + 1, updated_by_user_id = ${userId} WHERE id = ${invoiceId}`.execute(trx);
    await event(trx, organizationId, userId, kind === "discarded" ? "FINANCE_BILLING_DRAFT_DISCARDED" : "FINANCE_BILLING_DRAFT_RECOVERED", "invoice", invoiceId, { reason: input.reason, released });
    return { released };
  }));
}
export const discardDraft = (u: string, o: string, i: string, input: z.infer<typeof discardSchema>) => closeDraft(u, o, i, input, "discarded");
export const recoverDraft = (u: string, o: string, i: string, input: z.infer<typeof discardSchema>) => closeDraft(u, o, i, input, "abandoned_recovery");

// ---------------------------------------------------------------------------
// Reading

interface LineRow {
  id: string; kind: "shift" | "manual" | "discount"; shift_id: string | null; care_recipient_id: string | null; recipient_name: string | null;
  service_id: string | null; description: string; justification: string | null; service_date: string; real_start: string | null; real_end: string | null;
  approved_minutes: number | null; unit: string | null; quantity_hundredths: number; unit_price_cents: number | null; amount_cents: number;
  tax_treatment: TaxTreatment; tax_rate_basis_points: number | null; tax_legal_basis: string | null; needs_review: boolean; review_reasons: string[];
  warnings: { code: string; minutes?: number }[]; position: number; created_at: string; removed_at: string | null; remove_reason: string | null;
}

function blockersFor(lines: LineRow[], totals: ReturnType<typeof invoiceTotals>, rateChanged: boolean) {
  return [
    "ISSUING_NOT_AVAILABLE", // F2.2: issuing arrives in F2.3, behind its own permission
    ...(lines.length === 0 ? ["NO_LINES"] : []),
    ...(totals.taxPending ? ["TAX_PENDING"] : []),
    ...(lines.some((l) => l.needs_review) ? ["NEEDS_REVIEW"] : []),
    ...(totals.negativeTotal || totals.taxes.some((t) => t.negativeBase) ? ["NEGATIVE_AMOUNT"] : []),
    ...(rateChanged ? ["RATE_CHANGED"] : []),
  ];
}

export async function listInvoices(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "draft"]);
    const rows = (await sql<{ id: string; status: string; client_name: string; period_from: string; period_to: string; row_version: number; created_at: string; updated_at: string; created_by_email: string | null; line_count: number; subtotal: number; pending_tax: boolean; review: boolean; inactive: boolean; discard_kind: string | null }>`
      SELECT i.id, i.status, i.client_name, to_char(i.period_from, 'YYYY-MM-DD') AS period_from, to_char(i.period_to, 'YYYY-MM-DD') AS period_to,
        i.row_version, i.created_at, i.updated_at, u.email AS created_by_email, i.discard_kind,
        count(l.id) FILTER (WHERE l.removed_at IS NULL)::int AS line_count,
        COALESCE(sum(l.amount_cents) FILTER (WHERE l.removed_at IS NULL), 0)::int AS subtotal,
        COALESCE(bool_or(l.tax_treatment = 'pending') FILTER (WHERE l.removed_at IS NULL), false) AS pending_tax,
        COALESCE(bool_or(l.needs_review) FILTER (WHERE l.removed_at IS NULL), false) AS review,
        (i.status = 'draft' AND i.updated_at <= now() - make_interval(days => ${INACTIVE_DAYS})) AS inactive
      FROM invoices i LEFT JOIN users u ON u.id = i.created_by_user_id LEFT JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE i.organization_id = ${organizationId}
      GROUP BY i.id, u.email ORDER BY (i.status = 'draft') DESC, i.updated_at DESC LIMIT 300`.execute(trx)).rows;
    return {
      inactiveDays: INACTIVE_DAYS,
      invoices: rows.map((r) => ({
        id: r.id, status: r.status, clientName: r.client_name, periodFrom: r.period_from, periodTo: r.period_to, version: r.row_version,
        createdAt: r.created_at, updatedAt: r.updated_at, createdByEmail: r.created_by_email, lineCount: r.line_count, subtotalCents: r.subtotal,
        taxPending: r.pending_tax, needsReview: r.review, inactive: r.inactive, discardKind: r.discard_kind,
      })),
    };
  }));
}

export async function getInvoice(userId: string, organizationId: string, invoiceId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "draft"]);
    const canDraft = (await sql<{ ok: boolean }>`SELECT app_billing_can(${organizationId}::uuid, 'draft') AS ok`.execute(trx)).rows[0]?.ok === true;
    const inv = (await sql<{ id: string; status: string; billing_client_id: string; client_name: string; period_from: string; period_to: string; notes: string | null; row_version: number; created_at: string; updated_at: string; created_by_email: string | null; discarded_at: string | null; discard_reason: string | null; discard_kind: string | null; inactive: boolean }>`
      SELECT i.id, i.status, i.billing_client_id, i.client_name, to_char(i.period_from, 'YYYY-MM-DD') AS period_from, to_char(i.period_to, 'YYYY-MM-DD') AS period_to,
        i.notes, i.row_version, i.created_at, i.updated_at, u.email AS created_by_email, i.discarded_at, i.discard_reason, i.discard_kind,
        (i.status = 'draft' AND i.updated_at <= now() - make_interval(days => ${INACTIVE_DAYS})) AS inactive
      FROM invoices i LEFT JOIN users u ON u.id = i.created_by_user_id WHERE i.id = ${invoiceId} AND i.organization_id = ${organizationId}`.execute(trx)).rows[0];
    if (!inv) throw new BillingError("INVOICE_NOT_FOUND", 404);
    const all = (await sql<LineRow>`
      SELECT id, kind, shift_id, care_recipient_id, recipient_name, service_id, description, justification, to_char(service_date, 'YYYY-MM-DD') AS service_date,
        real_start, real_end, approved_minutes, unit, quantity_hundredths, unit_price_cents, amount_cents, tax_treatment, tax_rate_basis_points, tax_legal_basis,
        needs_review, review_reasons, warnings, position, created_at, removed_at, remove_reason
      FROM invoice_lines WHERE invoice_id = ${invoiceId} ORDER BY position, created_at`.execute(trx)).rows;
    const lines = all.filter((l) => !l.removed_at);
    const segments = lines.length ? (await sql<{ line_id: string; segment_date: string; starts_at: string; ends_at: string; minutes: number; billable_minutes: number; rate_source: string | null; day_type: string | null; holiday_name: string | null; unit_price_cents: number | null; amount_cents: number }>`
      SELECT line_id, to_char(segment_date, 'YYYY-MM-DD') AS segment_date, starts_at, ends_at, minutes, billable_minutes, rate_source, day_type, holiday_name, unit_price_cents, amount_cents
      FROM invoice_line_segments WHERE line_id = ANY (${lines.map((l) => l.id)}::uuid[]) ORDER BY starts_at`.execute(trx)).rows : [];
    // Rates changed since the line was computed? Only checked for people who can work on drafts (FINANZAS data).
    const changedLines: string[] = [];
    if (inv.status === "draft" && canDraft) {
      for (const l of lines.filter((x) => x.kind === "shift")) {
        const [row] = await shiftRows(trx, organizationId, { shiftIds: [l.shift_id!] });
        if (!row) continue;
        const priced = await priceRow(trx, organizationId, row, inv.billing_client_id);
        if (!priced.line || fingerprint(priced) !== (await storedPricing(trx, l.id))) changedLines.push(l.id);
      }
    }
    const totals = invoiceTotals(lines.map((l) => ({ amountCents: l.amount_cents, taxTreatment: l.tax_treatment, taxRateBasisPoints: l.tax_rate_basis_points })));
    return {
      invoice: {
        id: inv.id, status: inv.status, billingClientId: inv.billing_client_id, clientName: inv.client_name, periodFrom: inv.period_from, periodTo: inv.period_to,
        notes: inv.notes, version: inv.row_version, createdAt: inv.created_at, updatedAt: inv.updated_at, createdByEmail: inv.created_by_email,
        discardedAt: inv.discarded_at, discardReason: inv.discard_reason, discardKind: inv.discard_kind, inactive: inv.inactive, inactiveDays: INACTIVE_DAYS,
      },
      lines: lines.map((l) => ({ ...l, rateChanged: changedLines.includes(l.id), segments: segments.filter((s) => s.line_id === l.id) })),
      removedLines: all.filter((l) => l.removed_at).map((l) => ({ id: l.id, kind: l.kind, description: l.description, amountCents: l.amount_cents, removedAt: l.removed_at, reason: l.remove_reason })),
      totals,
      issueBlockers: inv.status === "draft" ? blockersFor(lines, totals, changedLines.length > 0) : [],
      canEdit: inv.status === "draft" && canDraft,
    };
  }));
}

/** Billing clients for the «Nueva factura» wizard (active ones, with their residents). */
export async function billingClients(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "draft");
    const clients = (await sql<{ id: string; full_name: string; recipients: string[] | null }>`
      SELECT c.id, c.full_name,
        array_remove(array_agg(DISTINCT NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '')), NULL) AS recipients
      FROM billing_clients c
      LEFT JOIN billing_client_recipients l ON l.billing_client_id = c.id
      LEFT JOIN care_recipients cr ON cr.id = l.care_recipient_id AND cr.organization_id = c.organization_id
      WHERE c.organization_id = ${organizationId} AND c.active GROUP BY c.id ORDER BY c.full_name`.execute(trx)).rows;
    const links = (await sql<{ billing_client_id: string; care_recipient_id: string; name: string | null }>`
      SELECT l.billing_client_id, l.care_recipient_id, NULLIF(trim(concat_ws(' ', cr.first_name, cr.last_name)), '') AS name
      FROM billing_client_recipients l JOIN care_recipients cr ON cr.id = l.care_recipient_id AND cr.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId}`.execute(trx)).rows;
    const services = (await sql<{ id: string; name: string; unit: string }>`
      SELECT id, name, unit FROM finance_services WHERE organization_id = ${organizationId} AND active ORDER BY name`.execute(trx)).rows;
    return {
      clients: clients.map((c) => ({ id: c.id, name: c.full_name, recipients: links.filter((l) => l.billing_client_id === c.id).map((l) => ({ id: l.care_recipient_id, name: l.name })) })),
      services,
    };
  }));
}

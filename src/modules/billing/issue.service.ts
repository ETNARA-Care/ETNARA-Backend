import { sql } from "kysely";
import { z } from "zod";
import { AGENCY_TIME_ZONE, recordFinanceEvent, recordFinancialAudit } from "../finance/financeEvents.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { BillingError, inBilling, requireAnyCapability, requireCapability, type Trx } from "./billing.service.js";
import { invoiceTotals, type TaxTreatment } from "./billingCalc.js";
import { PDF_GENERATOR_VERSION, renderInvoicePdf, type PdfInvoice, type PdfLine } from "./billingPdf.js";
import { BillingObjectIntegrityError, BillingStorageNotConfiguredError, getBillingObjectVerified, isBillingStorageConfigured, putBillingObject, sha256 } from "./billingStorage.js";
import { runBilling as run, rateChangedLines } from "./drafts.service.js";
import { agencyIssueBlockers } from "./readiness.js";
import { LOGO_MAX_INPUT_BYTES, LogoImageError, processLogo } from "../images/logoImage.js";

/**
 * Facturación Premium F2.3 — invoice profile, issuing with consecutive numbers,
 * frozen copy, private PDF, void, downloads.
 *
 * Issuing is ONE transaction: lock the draft, check every blocker, take the
 * next number from the agency's counter row (locked → concurrent issues of the
 * same agency wait; a failure anywhere rolls the number back, so there are no
 * gaps), freeze the copies, render the PDF, store it privately, record its
 * SHA-256. Real issuing stays refused until the agency's permissions manager
 * records that the tax configuration was validated (requirement of 25-oct).
 */

const reason = z.string().trim().min(3).max(300);
export const settingsSchema = z.object({
  legalName: z.string().trim().min(2).max(200).nullable().optional(),
  tradeName: z.string().trim().max(200).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  merchantRegistration: z.string().trim().max(60).nullable().optional(),
  paymentTerms: z.string().trim().max(300).nullable().optional(),
  footerNote: z.string().trim().max(500).nullable().optional(),
  showCaregiverName: z.boolean().optional(),
  retentionYears: z.number().int().min(6).max(30).optional(),
  prefix: z.string().trim().regex(/^[A-Z0-9]{1,6}$/).optional(),
});
export const taxValidationSchema = z.object({ validated: z.boolean(), note: reason.optional() });
export const issueSchema = z.object({ expectedVersion: z.number().int().min(1) });
export const voidSchema = z.object({ expectedVersion: z.number().int().min(1), reason });
export const LOGO_MAX_BYTES = LOGO_MAX_INPUT_BYTES; // 5 MB in; one optimised PNG (≤ 800 px) stored

const event = async (trx: Trx, organizationId: string, userId: string, action: string, entityType: string, entityId: string, newValue?: unknown, previousValue?: unknown) => {
  await recordFinanceEvent(trx, { organizationId, actorUserId: userId, action, entityType, entityId, newValue, previousValue });
  await recordFinancialAudit(trx, { organizationId, actorUserId: userId, action, entityType, entityId });
};

interface SettingsRow {
  legal_name: string | null; trade_name: string | null; address: string | null; phone: string | null; email: string | null;
  merchant_registration: string | null; payment_terms: string | null; footer_note: string | null; show_caregiver_name: boolean;
  retention_years: number; logo_object_key: string | null; logo_sha256: string | null; logo_content_type: string | null;
  tax_config_validated_at: string | null; tax_validation_note: string | null; validated_by_email: string | null;
}
async function settingsRow(trx: Trx, organizationId: string): Promise<SettingsRow | null> {
  return (await sql<SettingsRow>`
    SELECT s.legal_name, s.trade_name, s.address, s.phone, s.email, s.merchant_registration, s.payment_terms, s.footer_note,
      s.show_caregiver_name, s.retention_years, s.logo_object_key, s.logo_sha256, s.logo_content_type, s.tax_config_validated_at,
      s.tax_validation_note, u.email AS validated_by_email
    FROM billing_settings s LEFT JOIN users u ON u.id = s.tax_config_validated_by_user_id
    WHERE s.organization_id = ${organizationId}`.execute(trx)).rows[0] ?? null;
}
async function seriesRow(trx: Trx, organizationId: string) {
  return (await sql<{ prefix: string; next_number: number; first_issued_at: string | null }>`
    SELECT prefix, next_number, first_issued_at FROM invoice_series WHERE organization_id = ${organizationId}`.execute(trx)).rows[0] ?? null;
}

export async function getSettings(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "draft", "issue", "void", "manage"]);
    const s = await settingsRow(trx, organizationId);
    const series = await seriesRow(trx, organizationId);
    return {
      settings: {
        legalName: s?.legal_name ?? null, tradeName: s?.trade_name ?? null, address: s?.address ?? null, phone: s?.phone ?? null, email: s?.email ?? null,
        merchantRegistration: s?.merchant_registration ?? null, paymentTerms: s?.payment_terms ?? null, footerNote: s?.footer_note ?? null,
        showCaregiverName: s?.show_caregiver_name ?? false, retentionYears: s?.retention_years ?? 6, hasLogo: Boolean(s?.logo_object_key),
        taxValidatedAt: s?.tax_config_validated_at ?? null, taxValidationNote: s?.tax_validation_note ?? null, taxValidatedBy: s?.validated_by_email ?? null,
      },
      series: { prefix: series?.prefix ?? "FAC", nextNumber: series?.next_number ?? 1, locked: Boolean(series?.first_issued_at) },
      storageConfigured: isBillingStorageConfigured(),
      blockers: await agencyIssueBlockers(trx, organizationId),
    };
  }));
}

async function ensureSettings(trx: Trx, organizationId: string, userId: string) {
  await sql`INSERT INTO billing_settings (organization_id, updated_by_user_id) VALUES (${organizationId}, ${userId}) ON CONFLICT (organization_id) DO NOTHING`.execute(trx);
}

export async function updateSettings(userId: string, organizationId: string, input: z.infer<typeof settingsSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "manage");
    await ensureSettings(trx, organizationId, userId);
    const before = await settingsRow(trx, organizationId);
    const v = <T>(value: T | undefined, current: T) => (value === undefined ? current : value);
    await sql`UPDATE billing_settings SET
        legal_name = ${v(input.legalName, before!.legal_name)}, trade_name = ${v(input.tradeName, before!.trade_name)},
        address = ${v(input.address, before!.address)}, phone = ${v(input.phone, before!.phone)}, email = ${v(input.email, before!.email)},
        merchant_registration = ${v(input.merchantRegistration, before!.merchant_registration)},
        payment_terms = ${v(input.paymentTerms, before!.payment_terms)}, footer_note = ${v(input.footerNote, before!.footer_note)},
        show_caregiver_name = ${v(input.showCaregiverName, before!.show_caregiver_name)}, retention_years = ${v(input.retentionYears, before!.retention_years)},
        updated_by_user_id = ${userId}
      WHERE organization_id = ${organizationId}`.execute(trx);
    if (input.prefix !== undefined) {
      await sql`INSERT INTO invoice_series (organization_id, prefix, updated_by_user_id) VALUES (${organizationId}, ${input.prefix}, ${userId})
        ON CONFLICT (organization_id) DO UPDATE SET prefix = EXCLUDED.prefix, updated_by_user_id = EXCLUDED.updated_by_user_id`.execute(trx);
    }
    const { logo_object_key: _k, logo_sha256: _s, validated_by_email: _e, ...prev } = before!;
    void _k; void _s; void _e;
    await event(trx, organizationId, userId, "FINANCE_BILLING_SETTINGS_CHANGED", "billing_settings", organizationId, input, prev);
  }));
}

export async function setTaxValidation(userId: string, organizationId: string, input: z.infer<typeof taxValidationSchema>) {
  if (input.validated && !input.note) throw new BillingError("REASON_REQUIRED", 400);
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "manage");
    await ensureSettings(trx, organizationId, userId);
    await sql`UPDATE billing_settings SET
        tax_config_validated_at = ${input.validated ? sql`now()` : null}, tax_config_validated_by_user_id = ${input.validated ? userId : null},
        tax_validation_note = ${input.validated ? input.note! : null}, updated_by_user_id = ${userId}
      WHERE organization_id = ${organizationId}`.execute(trx);
    await event(trx, organizationId, userId, input.validated ? "FINANCE_BILLING_TAX_CONFIG_VALIDATED" : "FINANCE_BILLING_TAX_CONFIG_UNVALIDATED", "billing_settings", organizationId, { note: input.note ?? null });
  }));
}

const LOGO_ERROR_STATUS: Record<LogoImageError["code"], number> = {
  LOGO_EMPTY: 400, LOGO_TOO_LARGE: 413, LOGO_TYPE_NOT_ALLOWED: 415, LOGO_UNREADABLE: 415, LOGO_TOO_SMALL: 422, LOGO_BUSY: 503,
};

/**
 * Logo: PNG, JPEG or WebP (magic bytes) up to 5 MB, processed on the server into ONE optimised
 * PNG (≤ 800 px, proportions and transparency kept, no metadata). The original is never stored.
 * The permission is checked BEFORE the image is processed, and again when it is saved.
 */
export async function uploadLogo(userId: string, organizationId: string, body: Buffer) {
  if (!body?.length) throw new BillingError("LOGO_EMPTY", 400);
  if (body.length > LOGO_MAX_BYTES) throw new BillingError("LOGO_TOO_LARGE", 413);
  await inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "manage");
    if (!isBillingStorageConfigured()) throw new BillingError("BILLING_STORAGE_NOT_CONFIGURED", 503);
  }));
  let clean: Buffer;
  try {
    clean = (await processLogo(body)).body;
  } catch (e) {
    if (e instanceof LogoImageError) throw new BillingError(e.code, LOGO_ERROR_STATUS[e.code]);
    throw e;
  }
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "manage");
    if (!isBillingStorageConfigured()) throw new BillingError("BILLING_STORAGE_NOT_CONFIGURED", 503);
    const hash = sha256(clean);
    const key = `org/${organizationId}/logo/${hash}.png`;
    await putBillingObject(key, "image/png", clean);
    await ensureSettings(trx, organizationId, userId);
    await sql`UPDATE billing_settings SET logo_object_key = ${key}, logo_sha256 = ${hash}, logo_content_type = 'image/png', updated_by_user_id = ${userId}
      WHERE organization_id = ${organizationId}`.execute(trx);
    await event(trx, organizationId, userId, "FINANCE_BILLING_LOGO_CHANGED", "billing_settings", organizationId, { sha256: hash, bytes: clean.length });
    return { sha256: hash, bytes: clean.length };
  }));
}

export async function getLogo(userId: string, organizationId: string) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "draft", "issue", "void", "manage"]);
    const s = await settingsRow(trx, organizationId);
    if (!s?.logo_object_key || !s.logo_sha256) throw new BillingError("LOGO_NOT_FOUND", 404);
    return storageGuard(() => getBillingObjectVerified(s.logo_object_key!, s.logo_sha256!));
  }));
}

async function storageGuard<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) {
    if (e instanceof BillingStorageNotConfiguredError) throw new BillingError("BILLING_STORAGE_NOT_CONFIGURED", 503);
    if (e instanceof BillingObjectIntegrityError) throw new BillingError("BILLING_DOCUMENT_INTEGRITY", 409);
    if (e instanceof BillingError) throw e;
    throw new BillingError("BILLING_STORAGE_UNAVAILABLE", 503);
  }
}

// ---------------------------------------------------------------------------
// Issue / void

interface InvoiceLock { id: string; status: string; row_version: number; billing_client_id: string; period_from: string; period_to: string; notes: string | null }
async function lockInvoice(trx: Trx, organizationId: string, invoiceId: string) {
  const row = (await sql<InvoiceLock>`
    SELECT id, status, row_version, billing_client_id, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to, notes
    FROM invoices WHERE id = ${invoiceId} AND organization_id = ${organizationId} FOR UPDATE`.execute(trx)).rows[0];
  if (!row) throw new BillingError("INVOICE_NOT_FOUND", 404);
  return row;
}

interface StoredLine {
  id: string; kind: "shift" | "manual" | "discount"; shift_id: string | null; service_date: string; description: string; recipient_name: string | null;
  quantity_hundredths: number; unit: string | null; unit_price_cents: number | null; amount_cents: number; tax_treatment: TaxTreatment;
  tax_rate_basis_points: number | null; tax_legal_basis: string | null; needs_review: boolean; caregiver_name: string | null;
}
async function storedLines(trx: Trx, invoiceId: string) {
  return (await sql<StoredLine>`
    SELECT l.id, l.kind, l.shift_id, to_char(l.service_date, 'YYYY-MM-DD') AS service_date, l.description, l.recipient_name, l.quantity_hundredths, l.unit,
      l.unit_price_cents, l.amount_cents, l.tax_treatment, l.tax_rate_basis_points, l.tax_legal_basis, l.needs_review,
      l.caregiver_name -- frozen on the line (124): the PDF never reads a live profile
    FROM invoice_lines l WHERE l.invoice_id = ${invoiceId} AND l.removed_at IS NULL ORDER BY l.position, l.created_at`.execute(trx)).rows;
}

/**
 * Everything the PDF shows comes from data frozen at issue (snapshots, immutable lines and segments,
 * content-addressed logo). The original never carries the void mark, so either document can be rebuilt
 * byte for byte later (recovery: see rebuildDocument).
 */
export async function pdfInput(trx: Trx, organizationId: string, invoiceId: string, kind: "original" | "void_copy"): Promise<PdfInvoice> {
  const inv = (await sql<{ number_text: string; issue_date: string; issued_at: string; period_from: string; period_to: string; notes: string | null;
    issuer_snapshot: Record<string, unknown>; client_snapshot: Record<string, unknown>; totals_snapshot: Record<string, unknown>; status: string; voided_at: string | null; void_reason: string | null }>`
    SELECT number_text, to_char(issue_date, 'YYYY-MM-DD') AS issue_date, issued_at, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to,
      notes, issuer_snapshot, client_snapshot, totals_snapshot, status, voided_at, void_reason
    FROM invoices WHERE id = ${invoiceId} AND organization_id = ${organizationId}`.execute(trx)).rows[0];
  const issuer = inv.issuer_snapshot as { legalName: string; tradeName: string | null; address: string | null; phone: string | null; email: string | null; merchantRegistration: string | null; paymentTerms: string | null; footerNote: string | null; showCaregiverName: boolean; logo: { key: string; sha256: string } | null };
  const lines = await storedLines(trx, invoiceId);
  const segs = lines.length ? (await sql<{ line_id: string; segment_date: string; starts_at: string; ends_at: string; minutes: number; amount_cents: number; holiday_name: string | null }>`
    SELECT line_id, to_char(segment_date, 'YYYY-MM-DD') AS segment_date, starts_at, ends_at, minutes, amount_cents, holiday_name
    FROM invoice_line_segments WHERE line_id = ANY (${lines.map((l) => l.id)}::uuid[]) ORDER BY starts_at`.execute(trx)).rows : [];
  const logo = issuer.logo ? await storageGuard(() => getBillingObjectVerified(issuer.logo!.key, issuer.logo!.sha256)) : null;
  const totals = inv.totals_snapshot as unknown as PdfInvoice["totals"];
  const taxLabel = (l: StoredLine) => (l.tax_treatment === "taxable" ? `IVU ${(Number(l.tax_rate_basis_points) / 100).toLocaleString("es-PR")} %` : l.tax_treatment === "exempt" ? "Exento" : "IVU pendiente");
  return {
    numberText: inv.number_text, issueDate: inv.issue_date, issuedAt: new Date(inv.issued_at).toISOString(), periodFrom: inv.period_from, periodTo: inv.period_to, notes: inv.notes,
    issuer: { ...issuer, logo },
    client: inv.client_snapshot as unknown as PdfInvoice["client"],
    lines: lines.map((l): PdfLine => ({
      kind: l.kind, date: l.service_date, description: l.description, recipientName: l.recipient_name,
      caregiverName: issuer.showCaregiverName && l.kind === "shift" ? l.caregiver_name : null,
      quantityHundredths: l.quantity_hundredths, unit: l.unit, unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents, taxLabel: taxLabel(l),
      segments: segs.filter((s) => s.line_id === l.id).map((s) => ({ date: s.segment_date, startsAt: new Date(s.starts_at).toISOString(), endsAt: new Date(s.ends_at).toISOString(), minutes: s.minutes, amountCents: s.amount_cents, holiday: s.holiday_name })),
    })),
    totals,
    voided: kind === "void_copy" && inv.status === "voided" ? { at: new Date(inv.voided_at!).toISOString(), reason: inv.void_reason! } : null,
  };
}

export async function issueInvoice(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof issueSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "issue");
    const inv = await lockInvoice(trx, organizationId, invoiceId);
    if (inv.status === "issued" || inv.status === "voided") throw new BillingError("ALREADY_ISSUED", 409);
    if (inv.status !== "draft") throw new BillingError("INVOICE_NOT_EDITABLE", 409);
    if (inv.row_version !== input.expectedVersion) throw new BillingError("DRAFT_CHANGED", 409);

    const lines = await storedLines(trx, invoiceId);
    const totals = invoiceTotals(lines.map((l) => ({ amountCents: l.amount_cents, taxTreatment: l.tax_treatment, taxRateBasisPoints: l.tax_rate_basis_points })));
    const changed = await rateChangedLines(trx, organizationId, invoiceId, inv.billing_client_id);
    const blockers = [
      ...(await agencyIssueBlockers(trx, organizationId)),
      ...(lines.length === 0 ? ["NO_LINES"] : []),
      ...(totals.taxPending ? ["TAX_PENDING"] : []),
      ...(lines.some((l) => l.needs_review) ? ["NEEDS_REVIEW"] : []),
      ...(totals.negativeTotal || totals.taxes.some((t) => t.negativeBase) ? ["NEGATIVE_AMOUNT"] : []),
      ...(changed.length ? ["RATE_CHANGED"] : []),
    ];
    if (blockers.length) throw Object.assign(new BillingError("ISSUE_BLOCKED", 409), { detail: { blockers } });

    // D4: the next number of this agency. The counter row is locked until COMMIT; any failure below
    // (PDF, storage, database) rolls the increment back with everything else: no gaps, no duplicates.
    await sql`INSERT INTO invoice_series (organization_id, updated_by_user_id) VALUES (${organizationId}, ${userId}) ON CONFLICT (organization_id) DO NOTHING`.execute(trx);
    const seq = (await sql<{ n: number; prefix: string }>`
      UPDATE invoice_series SET next_number = next_number + 1, first_issued_at = COALESCE(first_issued_at, now()), updated_by_user_id = ${userId}
      WHERE organization_id = ${organizationId} RETURNING next_number - 1 AS n, prefix`.execute(trx)).rows[0];
    const numberText = `${seq.prefix}-${String(seq.n).padStart(6, "0")}`;
    const s = (await settingsRow(trx, organizationId))!;
    const client = (await sql<{ full_name: string; address: string | null }>`SELECT full_name, address FROM billing_clients WHERE id = ${inv.billing_client_id}`.execute(trx)).rows[0];
    const issuerSnapshot = {
      legalName: s.legal_name, tradeName: s.trade_name, address: s.address, phone: s.phone, email: s.email, merchantRegistration: s.merchant_registration,
      paymentTerms: s.payment_terms, footerNote: s.footer_note, showCaregiverName: s.show_caregiver_name,
      logo: s.logo_object_key && s.logo_sha256 ? { key: s.logo_object_key, sha256: s.logo_sha256 } : null,
    };
    const exemptBases = [...new Set(lines.filter((l) => l.tax_treatment === "exempt" && l.tax_legal_basis).map((l) => l.tax_legal_basis!))];
    const totalsSnapshot = { ...totals, exemptBases };
    await sql`UPDATE invoices SET status = 'issued', invoice_number = ${seq.n}, number_text = ${numberText}, issued_at = now(), issued_by_user_id = ${userId},
        issue_date = (now() AT TIME ZONE ${AGENCY_TIME_ZONE})::date,
        issuer_snapshot = ${JSON.stringify(issuerSnapshot)}::jsonb, client_snapshot = ${JSON.stringify({ name: client.full_name, address: client.address })}::jsonb,
        totals_snapshot = ${JSON.stringify(totalsSnapshot)}::jsonb,
        retention_until = ((now() AT TIME ZONE ${AGENCY_TIME_ZONE})::date + make_interval(years => ${Math.max(6, s.retention_years)}))::date,
        row_version = row_version + 1, updated_by_user_id = ${userId}
      WHERE id = ${invoiceId}`.execute(trx);

    const pdf = await renderInvoicePdf(await pdfInput(trx, organizationId, invoiceId, "original"));
    const hash = sha256(pdf);
    const key = `org/${organizationId}/invoices/${invoiceId}/original-${hash}.pdf`;
    await storageGuard(() => putBillingObject(key, "application/pdf", pdf));
    await sql`INSERT INTO invoice_documents (organization_id, invoice_id, kind, object_key, sha256, size_bytes, generator_version, created_by_user_id)
      VALUES (${organizationId}, ${invoiceId}, 'original', ${key}, ${hash}, ${pdf.length}, ${PDF_GENERATOR_VERSION}, ${userId})`.execute(trx);
    await event(trx, organizationId, userId, "FINANCE_BILLING_INVOICE_ISSUED", "invoice", invoiceId, { number: numberText, totalCents: totals.totalCents, lines: lines.length });
    await event(trx, organizationId, userId, "FINANCE_BILLING_PDF_GENERATED", "invoice", invoiceId, { kind: "original", sha256: hash, bytes: pdf.length });
    return { number: numberText, totalCents: totals.totalCents };
  }));
}

export async function voidInvoice(userId: string, organizationId: string, invoiceId: string, input: z.infer<typeof voidSchema>) {
  return inBilling(userId, organizationId, (trx) => run(async () => {
    await requireCapability(trx, organizationId, "void");
    const inv = await lockInvoice(trx, organizationId, invoiceId);
    if (inv.status === "voided") throw new BillingError("ALREADY_VOIDED", 409);
    if (inv.status !== "issued") throw new BillingError("INVOICE_NOT_ISSUED", 409);
    if (inv.row_version !== input.expectedVersion) throw new BillingError("DRAFT_CHANGED", 409);
    await sql`UPDATE invoices SET status = 'voided', voided_at = now(), voided_by_user_id = ${userId}, void_reason = ${input.reason},
      row_version = row_version + 1, updated_by_user_id = ${userId} WHERE id = ${invoiceId}`.execute(trx);
    const released = (await sql<{ shift_id: string }>`
      UPDATE invoice_shift_claims SET released_at = now(), released_by_user_id = ${userId}, release_reason = ${input.reason}, release_kind = 'invoice_voided'
      WHERE invoice_id = ${invoiceId} AND released_at IS NULL RETURNING shift_id`.execute(trx)).rows;
    for (const r of released) await event(trx, organizationId, userId, "FINANCE_BILLING_RESERVATION_RELEASED", "shift", r.shift_id, { invoiceId, kind: "invoice_voided" });
    const pdf = await renderInvoicePdf(await pdfInput(trx, organizationId, invoiceId, "void_copy"));
    const hash = sha256(pdf);
    const key = `org/${organizationId}/invoices/${invoiceId}/void_copy-${hash}.pdf`;
    await storageGuard(() => putBillingObject(key, "application/pdf", pdf));
    await sql`INSERT INTO invoice_documents (organization_id, invoice_id, kind, object_key, sha256, size_bytes, generator_version, created_by_user_id)
      VALUES (${organizationId}, ${invoiceId}, 'void_copy', ${key}, ${hash}, ${pdf.length}, ${PDF_GENERATOR_VERSION}, ${userId})`.execute(trx);
    await event(trx, organizationId, userId, "FINANCE_BILLING_INVOICE_VOIDED", "invoice", invoiceId, { reason: input.reason, released: released.length });
    await event(trx, organizationId, userId, "FINANCE_BILLING_PDF_GENERATED", "invoice", invoiceId, { kind: "void_copy", sha256: hash, bytes: pdf.length });
    return { released: released.length };
  }));
}

/** Private, authorised download; the bytes are checked against the SHA-256 recorded at issue. */
export async function downloadDocument(userId: string, organizationId: string, invoiceId: string, kind: "original" | "void_copy") {
  // Tenant context (RLS as this user in this agency): the export guard checks for it in the file that builds the download.
  return withTenantContext({ userId, organizationId }, (trx) => run(async () => {
    await requireAnyCapability(trx, organizationId, ["view", "issue", "void"]);
    const doc = (await sql<{ object_key: string; sha256: string; number_text: string }>`
      SELECT d.object_key, d.sha256, i.number_text FROM invoice_documents d JOIN invoices i ON i.id = d.invoice_id
      WHERE d.invoice_id = ${invoiceId} AND d.organization_id = ${organizationId} AND d.kind = ${kind}`.execute(trx)).rows[0];
    if (!doc) throw new BillingError("DOCUMENT_NOT_FOUND", 404);
    const body = await storageGuard(() => getBillingObjectVerified(doc.object_key, doc.sha256));
    await event(trx, organizationId, userId, "FINANCE_BILLING_PDF_DOWNLOADED", "invoice", invoiceId, { kind });
    const filename = `${doc.number_text}${kind === "void_copy" ? "-ANULADA" : ""}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_");
    return { body, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` } };
  }));
}

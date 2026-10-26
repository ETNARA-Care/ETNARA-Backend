import type { Response } from "express";
import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import { callDb } from "./shiftReports.service.js";
import { renderShiftReportPdf, type FamilyShiftReport } from "./shiftReportPdf.js";

/**
 * Informe de Turno F3 (migration 129): the family reads APPROVED reports of a resident
 * she is authorized for, only the sections the agency allowed, and downloads the PDF.
 * Everything goes through app_shift_report_family_* (SECURITY DEFINER, checks the
 * active family relationship + FAMILY role + SHIFT_REPORTS, never ETNARA Central).
 * The PDF is rendered from the SAME projection the portal shows: it can't show more.
 * No public links: every download is an authenticated request; nothing is stored.
 */

export async function listFamilyShiftReports(userId: string, organizationId: string, recipientId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await callDb(() => sql<{ v: unknown }>`SELECT app_shift_report_family_list(${recipientId}::uuid) AS v`.execute(trx));
    return { reports: r.rows[0]?.v ?? [] };
  });
}

export async function getFamilyShiftReport(userId: string, organizationId: string, recipientId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await callDb(() => sql<{ v: FamilyShiftReport }>`SELECT app_shift_report_family_get(${recipientId}::uuid, ${reportId}::uuid) AS v`.execute(trx));
    return { report: r.rows[0].v };
  });
}

/** The PDF bytes plus a file name with no personal names (only the date and a short id). */
export async function familyShiftReportPdf(userId: string, organizationId: string, recipientId: string, reportId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const r = await callDb(() => sql<{ v: FamilyShiftReport }>`SELECT app_shift_report_family_pdf(${recipientId}::uuid, ${reportId}::uuid) AS v`.execute(trx));
    const report = r.rows[0].v;
    const body = await renderShiftReportPdf(report);
    return { body, fileName: `informe-de-turno-${report.serviceDate}-${report.id.slice(0, 8)}.pdf` };
  });
}

/** Sends the PDF: private, never cached, always as a download; no names in the file name. */
export function sendShiftReportPdf(res: Response, pdf: { body: Buffer; fileName: string }) {
  res.status(200);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${pdf.fileName}"`);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(pdf.body.length));
  res.end(pdf.body);
}

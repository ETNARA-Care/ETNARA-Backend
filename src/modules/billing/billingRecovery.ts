import { sql } from "kysely";
import type { Trx } from "./billing.service.js";
import { PDF_GENERATOR_VERSION, renderInvoicePdf } from "./billingPdf.js";
import { getBillingObjectVerified, putBillingObject, sha256 } from "./billingStorage.js";
import { pdfInput } from "./issue.service.js";
import { recordFinanceEvent } from "../finance/financeEvents.js";

/**
 * Facturación F2.3 — recovery of a lost or damaged invoice PDF WITHOUT changing the issued invoice.
 *
 * Order of preference:
 *   1. The object is intact (bytes match the SHA-256 recorded at issue) → nothing to do.
 *   2. Restore the same object key from the independent daily copy (ops procedure, outside the app).
 *   3. Rebuild: the PDF is deterministic and built only from frozen data (snapshots, immutable lines
 *      and segments, content-addressed logo). It is rebuilt and accepted ONLY if its SHA-256 equals
 *      the recorded one; then it is written back to the SAME key. Any difference (other generator
 *      version, library or locale data) is refused: a different file is never stored as the invoice.
 * No invoice, line, document row or number is ever modified; only a finance event is added.
 */
export type RecoveryOutcome =
  | { status: "INTACT" }
  | { status: "RECOVERABLE" } // dry run: the rebuild matches; nothing written
  | { status: "RECOVERED" }
  | { status: "REFUSED"; reason: "DOCUMENT_NOT_FOUND" | "GENERATOR_CHANGED" | "REBUILD_MISMATCH" | "WRITE_NOT_VERIFIED" };

export async function recoverInvoiceDocument(trx: Trx, input: { organizationId: string; invoiceId: string; kind: "original" | "void_copy"; actorUserId: string; apply: boolean }): Promise<RecoveryOutcome> {
  const doc = (await sql<{ object_key: string; sha256: string; generator_version: string }>`
    SELECT object_key, sha256, generator_version FROM invoice_documents
    WHERE organization_id = ${input.organizationId} AND invoice_id = ${input.invoiceId} AND kind = ${input.kind}`.execute(trx)).rows[0];
  if (!doc) return { status: "REFUSED", reason: "DOCUMENT_NOT_FOUND" };
  const intact = await getBillingObjectVerified(doc.object_key, doc.sha256).then(() => true, () => false);
  if (intact) return { status: "INTACT" };
  if (doc.generator_version !== PDF_GENERATOR_VERSION) return { status: "REFUSED", reason: "GENERATOR_CHANGED" };
  const rebuilt = await renderInvoicePdf(await pdfInput(trx, input.organizationId, input.invoiceId, input.kind));
  if (sha256(rebuilt) !== doc.sha256) return { status: "REFUSED", reason: "REBUILD_MISMATCH" };
  if (!input.apply) return { status: "RECOVERABLE" };
  await putBillingObject(doc.object_key, "application/pdf", rebuilt);
  const ok = await getBillingObjectVerified(doc.object_key, doc.sha256).then(() => true, () => false);
  if (!ok) return { status: "REFUSED", reason: "WRITE_NOT_VERIFIED" };
  await recordFinanceEvent(trx, { organizationId: input.organizationId, actorUserId: input.actorUserId, action: "FINANCE_BILLING_PDF_RECOVERED",
    entityType: "invoice", entityId: input.invoiceId, newValue: { kind: input.kind, sha256: doc.sha256, method: "verified_rebuild" } });
  return { status: "RECOVERED" };
}

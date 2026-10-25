import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { renderInvoicePdf } from "../src/modules/billing/billingPdf.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";

describe("ETNARA Facturación F2.3 — issue, numbering, PDF, void (127)", () => {
  const m = read("migrations/127_billing_issue_void.sql");
  const code = m.replace(/--.*$/gm, "");
  const svc = read("src/modules/billing/issue.service.ts");
  const storage = read("src/modules/billing/billingStorage.ts");
  const rollback = read("ops/127_billing_issue_void.rollback.sql");

  it("numbers come from a locked counter row inside the issue transaction (no sequence, no gaps)", () => {
    expect(code).not.toMatch(/CREATE SEQUENCE|nextval/i);
    expect(svc).toContain("UPDATE invoice_series SET next_number = next_number + 1");
    expect(m).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_number ON invoices (organization_id, invoice_number)");
    expect(m).toContain("RAISE EXCEPTION 'NUMBER_NEVER_DECREASES'");
    expect(m).toContain("RAISE EXCEPTION 'PREFIX_LOCKED'");
  });

  it("real issuing is refused until the tax configuration is validated; nothing tax-related is preloaded", () => {
    expect(read("src/modules/billing/readiness.ts")).toContain('"TAX_CONFIG_NOT_VALIDATED"');
    expect(code).not.toMatch(/INSERT INTO (billing_settings|finance_service_tax)/);
    expect(svc).toContain('if (blockers.length) throw Object.assign(new BillingError("ISSUE_BLOCKED", 409)');
  });

  it("issued and voided invoices are immutable; voiding only records who, when and why", () => {
    expect(m).toContain("RAISE EXCEPTION 'INVOICE_IMMUTABLE'");
    expect(m).toContain("v_allowed := ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason', 'row_version', 'updated_at', 'updated_by_user_id']");
    expect(m).toContain("RAISE EXCEPTION 'DOCUMENT_IMMUTABLE'");
    expect(code).not.toMatch(/GRANT[^;]*DELETE/);
  });

  it("private storage: own bucket, no presigned URLs, SHA-256 verified on every read, never deletes", () => {
    expect(storage).toContain("never share a bucket with documents or photos");
    expect(storage).not.toMatch(/getSignedUrl|DeleteObject/);
    expect(storage).toContain("if (sha256(body) !== expectedSha256) throw new BillingObjectIntegrityError()");
    expect(read("src/modules/billing/billing.routes.ts")).toContain('res.setHeader("Cache-Control", "private, no-store")');
  });

  it("D9: the caregiver's name only when the agency enabled it; the PDF has no clinical data", () => {
    expect(svc).toContain('caregiverName: issuer.showCaregiverName && l.kind === "shift" ? l.caregiver_name : null');
    expect(m).toContain("show_caregiver_name boolean NOT NULL DEFAULT false");
    expect(read("src/modules/billing/billingPdf.ts").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/diagnos|care_event|observation|latitude|longitude/i);
  });

  it("writes stay behind FACTURACION; PDF downloads pass in read-only mode", () => {
    expect(gatedFeatureFor(`/organizations/${O}/billing/invoices/x/issue`, "POST")).toEqual({ organizationId: O, feature: "FACTURACION" });
    expect(gatedFeatureFor(`/organizations/${O}/billing/invoices/x/pdf`, "GET")?.readOnlyPass).toBe(true);
  });

  it("renders a valid PDF from a frozen copy, with the ANULADA mark on the void copy", async () => {
    const base = {
      numberText: "CS-000001", issueDate: "2026-10-25", periodFrom: "2026-10-01", periodTo: "2026-10-31", issuedAt: "2026-10-25T15:00:00.000Z",
      issuer: { legalName: "Agencia Ficticia", tradeName: null, address: "San Juan", phone: null, email: null, merchantRegistration: null, paymentTerms: "15 días", footerNote: null, logo: null },
      client: { name: "Cliente Ficticio", address: null }, notes: null,
      lines: [{ kind: "shift" as const, date: "2026-10-11", description: "Cuido · Ana", recipientName: "Ana", caregiverName: null, quantityHundredths: 800, unit: "hour", unitPriceCents: null, amountCents: 27900, taxLabel: "Exento",
        segments: [{ date: "2026-10-11", startsAt: "2026-10-12T02:00:00.000Z", endsAt: "2026-10-12T04:00:00.000Z", minutes: 120, amountCents: 5400, holiday: null },
          { date: "2026-10-12", startsAt: "2026-10-12T04:00:00.000Z", endsAt: "2026-10-12T10:00:00.000Z", minutes: 360, amountCents: 22500, holiday: "Día de la Raza" }] }],
      totals: { subtotalCents: 27900, taxes: [], exemptBaseCents: 27900, totalCents: 27900, exemptBases: ["Base ficticia"] },
    };
    const pdf = await renderInvoicePdf(base);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const hex = (buf: Buffer) => [...buf.toString("latin1").matchAll(/<([0-9a-fA-F]{2,})>/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1")).join("");
    expect(hex(pdf)).toContain("CS-000001");
    expect(hex(pdf)).not.toContain("ANULADA");
    const voided = await renderInvoicePdf({ ...base, voided: { at: "2026-10-26T12:00:00.000Z", reason: "Prueba" } });
    expect(hex(voided)).toContain("ANULADA");
  });

  it("guarded rollback", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '127_billing_issue_void.sql'");
  });
});

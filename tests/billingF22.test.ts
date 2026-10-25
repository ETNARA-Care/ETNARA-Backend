import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const O = "11111111-2222-4333-8444-555555555555";

describe("ETNARA Facturación F2.2 — drafts, reservations, tax treatment (124)", () => {
  const m124 = read("migrations/124_billing_drafts.sql");
  const code = m124.replace(/--.*$/gm, "");
  const service = read("src/modules/billing/drafts.service.ts");
  const routes = read("src/modules/billing/billing.routes.ts");
  const rollback = read("ops/124_billing_drafts.rollback.sql");

  it("is additive; 124 alone only allows draft/discarded (issuing arrives with 127)", () => {
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
    expect(code).not.toMatch(/ALTER TABLE (shifts|timesheets|finance_rates|finance_services|billing_clients)\b/);
    expect(code).toContain("status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'discarded'))");
    expect(routes).toContain("/issue"); // F2.3 (127)
  });

  it("nothing tax-related is preloaded or assumed", () => {
    expect(code).not.toMatch(/INSERT INTO finance_service_tax/);
    expect(service).toContain('return row ?? { treatment: "pending"');
    expect(service).toMatch(/taxTreatment: z\.enum\(\["taxable", "exempt", "pending"\]\)/);
    expect(service).not.toMatch(/taxTreatment: z\.enum\([^)]*\)\.default/);
  });

  it("one live reservation per shift, released only by line removal, discard or audited recovery", () => {
    expect(m124).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_shift_claims_live ON invoice_shift_claims (shift_id) WHERE released_at IS NULL");
    expect(m124).toContain("release_kind IN ('line_removed', 'draft_discarded', 'abandoned_recovery')");
    expect(service).toContain("export const INACTIVE_DAYS = 14");
    expect(service).toContain('throw new BillingError("DRAFT_NOT_INACTIVE", 409)');
    expect(service).not.toMatch(/setInterval|setTimeout|node-cron/);
  });

  it("approved hours only; review lines are added flagged and block issuing; tolerance only warns", () => {
    expect(service).toContain('exceptions.push("HOURS_NOT_APPROVED")');
    expect(service).toContain("if (!priced.line) throw Object.assign(new BillingError(\"SHIFT_NOT_BILLABLE\"");
    expect(service).toContain('...(lines.some((l) => l.needs_review) ? ["NEEDS_REVIEW"] : [])');
    expect(service).toContain("export const TOLERANCE_MINUTES = 15");
    expect(read("src/modules/billing/billingCalc.ts")).toContain('warnings.push({ code: "DAY_ALMOST_COMPLETE"');
  });

  it("manual lines can never stand in for a reserved shift and always carry a justification", () => {
    expect(service).toContain('throw new BillingError("MANUAL_LINE_DUPLICATES_SHIFT", 409)');
    expect(m124).toContain("kind = 'manual' AND shift_id IS NULL AND justification IS NOT NULL");
    expect(m124).toContain("kind = 'discount' AND shift_id IS NULL AND justification IS NOT NULL AND amount_cents <= 0");
  });

  it("RLS by capability on every table, platform deny, no DELETE, guards for the owner", () => {
    for (const t of ["finance_service_tax", "invoices", "invoice_lines", "invoice_line_segments", "invoice_shift_claims"]) expect(m124).toContain(`'${t}'`);
    expect(m124).toContain("CREATE POLICY platform_finance_deny ON %I AS RESTRICTIVE");
    expect(code).not.toMatch(/GRANT[^;]*DELETE/);
    expect(m124).toContain("RAISE EXCEPTION 'BILLING_NO_DELETE'");
    expect(m124).toContain("RAISE EXCEPTION 'DRAFT_CHANGED'");
  });

  it("writes stay behind FACTURACION at the gate; reads pass in read-only mode", () => {
    expect(gatedFeatureFor(`/organizations/${O}/billing/invoices`, "POST")).toEqual({ organizationId: O, feature: "FACTURACION" });
    expect(gatedFeatureFor(`/organizations/${O}/billing/invoices/x`, "PATCH")).toEqual({ organizationId: O, feature: "FACTURACION" });
    expect(gatedFeatureFor(`/organizations/${O}/billing/invoices`, "GET")?.readOnlyPass).toBe(true);
  });

  it("guarded rollback", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toContain("DELETE FROM schema_migrations WHERE filename = '124_billing_drafts.sql'");
  });
});

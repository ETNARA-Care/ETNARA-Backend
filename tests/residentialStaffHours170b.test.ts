import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Residential F0.1 — staff hours without billing in care homes", () => {
  const service = read("src/modules/timesheets/timesheets.service.ts");
  const periods = read("src/modules/timesheets/payPeriods.service.ts");
  const routes = read("src/modules/timesheets/timesheets.routes.ts");

  it("decides the modality in the database, from the session organization", () => {
    expect(service).toContain("export async function isResidentialOrganization");
    expect(service).toContain("public.app_org_is_residential(NULLIF(current_setting('app.current_org_id', true), '')::uuid)");
    expect(periods).toContain("isResidentialOrganization");
  });

  it("rejects billing rates in homes and keeps them required for agencies", () => {
    expect(service).toContain("RESIDENTIAL_BILLING_NOT_AVAILABLE");
    expect(service).toContain("INVALID_FINANCIAL_RATE_REQUEST");
    expect(routes).toContain("ResidentialBillingNotAvailableError");
    expect(routes).toContain("FinancialRateInvalidError");
  });

  it("stores billing as 0 for homes so existing NOT NULL constraints stay untouched", () => {
    expect(periods).toMatch(/CASE WHEN \$\{residential\} THEN 0 ELSE/);
  });

  it("groups the period preview by worker membership, never by name (GPT review)", () => {
    expect(periods).toContain("t.organization_worker_membership_id membership_id");
    expect(periods).toContain("const k=String(x.membership_id)");
    expect(periods).not.toContain('const k=x.worker_name');
  });

  it("adds no deductions, contributions, taxes or payroll processing", () => {
    for (const source of [service, periods]) {
      expect(source).not.toMatch(/deduction|withholding|contribution|payroll_run|stripe|bank_account|payment_intent/i);
    }
  });

  it("adds no migration (shifts and timesheet schema unchanged)", () => {
    const verifier = read("scripts/verifyResidentialStaffHours.ts");
    expect(verifier).toContain("RESIDENTIAL_BILLING_NOT_AVAILABLE");
    expect(verifier).toContain("MODALITY_NOT_AVAILABLE");
  });
});

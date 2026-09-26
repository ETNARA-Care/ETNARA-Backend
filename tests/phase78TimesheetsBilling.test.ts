import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 7.8 timesheets, billing and payroll preparation", () => {
  it("stores money as cents and protects financial data with manager-only RLS", () => {
    const migration = read("migrations/058_timesheets_financial_rates.sql");
    expect(migration).toContain("pay_rate_cents");
    expect(migration).toContain("bill_rate_cents");
    expect(migration).toContain("pay_amount_cents");
    expect(migration).toContain("bill_amount_cents");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).not.toMatch(/numeric\s*\(|decimal\s*\(/i);
    expect(migration).not.toContain("GRANT DELETE");
  });

  it("creates one immutable-source timesheet from a paired checkout", () => {
    const migration = read("migrations/058_timesheets_financial_rates.sql");
    const verification = read("src/modules/verification/verification.service.ts");
    const service = read("src/modules/timesheets/timesheets.service.ts");
    expect(migration).toContain("UNIQUE (organization_id, shift_id, organization_worker_membership_id)");
    expect(service).toContain("recordTimesheetFromCheckout");
    expect(service).toContain("app_record_timesheet_from_checkout");
    expect(migration).toContain("ON CONFLICT (organization_id, shift_id, organization_worker_membership_id) DO NOTHING");
    expect(verification).toContain("recordTimesheetFromCheckout");
  });

  it("snapshots manager-only bill rates without exposing them to the caregiver", () => {
    const migration = read("migrations/058_timesheets_financial_rates.sql");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app_record_timesheet_from_checkout");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION app_record_timesheet_from_checkout");
    expect(migration).toContain("GRANT SELECT, UPDATE ON timesheets TO app_runtime");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE ON timesheets TO app_runtime");
  });

  it("requires manager review, configured rates and an audit trail", () => {
    const service = read("src/modules/timesheets/timesheets.service.ts");
    const routes = read("src/modules/timesheets/timesheets.routes.ts");
    expect(service).toContain("SELECT app_is_org_manager() AS is_manager");
    expect(service).toContain("FINANCIAL_RATE_REQUIRED");
    expect(service).toContain("TIMESHEET_APPROVED");
    expect(service).toContain("TIMESHEET_DISPUTED");
    expect(service).toContain("WORKER_FINANCIAL_RATE_CHANGED");
    expect(routes).toContain("/organizations/:organizationId/timesheets/:timesheetId/review");
  });

  it("does not move money, run payroll or expose a Family endpoint", () => {
    const service = read("src/modules/timesheets/timesheets.service.ts");
    const routes = read("src/modules/timesheets/timesheets.routes.ts");
    expect(service).not.toMatch(/stripe|ach|bank_account|payment_intent/i);
    expect(routes).not.toMatch(/family/i);
  });
});

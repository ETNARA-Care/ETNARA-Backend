import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 7.9 pay-period close", () => {
  it("keeps periods manager-only and organization scoped", () => {
    const migration = read("migrations/059_pay_periods.sql");

    expect(migration).toContain("CREATE TABLE pay_periods");
    expect(migration).toContain("CREATE TABLE pay_period_timesheets");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("app.current_org_id");
    expect(migration).toContain("UNIQUE (organization_id,date_from,date_to)");
    expect(migration).toContain("UNIQUE(timesheet_id)");
  });

  it("previews, closes and lists real periods without moving money", () => {
    const routes = read("src/modules/timesheets/payPeriods.routes.ts");
    const service = read("src/modules/timesheets/payPeriods.service.ts");

    expect(routes).toContain("/pay-periods/preview");
    expect(routes).toContain("/pay-periods/close");
    expect(service).toContain("PAY_PERIOD_HAS_EXCEPTIONS");
    expect(service).toContain("PAY_PERIOD_ALREADY_EXISTS");
    expect(service).toContain("PAY_PERIOD_CLOSED");
    expect(service).toContain("pay_period_timesheets");
    expect(service).not.toMatch(/stripe|payment_intent|issueInvoice/i);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("ETNARA Finanzas F0 — safe financial foundation (118)", () => {
  const m118 = read("migrations/118_finance_foundation.sql");
  const rollback = read("ops/118_finance_foundation.rollback.sql");

  it("never touches the check-out path or existing data", () => {
    expect(m118).not.toMatch(/FUNCTION\s+(public\.)?app_record_timesheet_from_checkout/i);
    expect(m118).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\s+(public\.)?(timesheets|audit_log|worker_financial_rates|pay_periods|pay_period_timesheets)\b/i);
    expect(m118).not.toMatch(/\bINSERT INTO\b/i);
    expect(m118).not.toMatch(/DROP TABLE/i);
  });

  it("adds FINANZAS as a switch that only ETNARA central can turn on", () => {
    expect(m118).toContain("'SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS'");
    expect(read("src/modules/platformOrganizations/platformOrganizationFeatures.ts")).toMatch(/FEATURE_CODES = \[[^\]]*"FINANZAS"\]/);
    expect(read("src/middleware/orgFeatureRules.ts")).toContain('| "FINANZAS"');
  });

  it("hides financial audit rows from everyone but the agency admin, and from ETNARA central", () => {
    expect(m118).toMatch(/CREATE POLICY audit_log_financial_admin_only ON audit_log\s+AS RESTRICTIVE FOR SELECT TO app_runtime/);
    expect(m118).toContain("app_is_org_admin() AND NOT app_is_superadmin()");
    for (const action of ["WORKER_FINANCIAL_RATE_CHANGED", "TIMESHEET_APPROVED", "TIMESHEET_DISPUTED", "PAY_PERIOD_CLOSED"]) {
      expect(m118).toContain(`'${action}'`);
    }
  });

  it("keeps financial values in an append-only, admin-only finance_events", () => {
    expect(m118).toContain("CREATE TABLE IF NOT EXISTS finance_events");
    expect(m118).toContain("GRANT SELECT, INSERT ON finance_events TO app_runtime");
    expect(m118).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*ON finance_events/);
    expect(m118).toContain("BEFORE UPDATE OR DELETE ON finance_events");
    expect(m118).toContain("BEFORE TRUNCATE ON finance_events");
  });

  it("denies ETNARA central on every financial table and freezes approved timesheets", () => {
    for (const table of ["timesheets", "worker_financial_rates", "pay_periods", "pay_period_timesheets", "finance_events"]) {
      expect(m118).toContain(`'${table}'`);
    }
    expect(m118).toContain("AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin())");
    expect(m118).toContain("IF OLD.status = 'approved' THEN");
    expect(m118).toContain("BEFORE UPDATE OR DELETE ON timesheets");
  });

  it("writes no amounts into audit_log from the services", () => {
    const timesheets = read("src/modules/timesheets/timesheets.service.ts");
    const periods = read("src/modules/timesheets/payPeriods.service.ts");
    expect(timesheets).not.toContain("INSERT INTO audit_log");
    expect(periods).not.toContain("INSERT INTO audit_log");
    expect(timesheets).toContain("recordFinanceEvent");
    expect(periods).toContain("recordFinanceEvent");
  });

  it("uses Puerto Rico days and never sends a database message in a 500", () => {
    const timesheets = read("src/modules/timesheets/timesheets.service.ts");
    const periods = read("src/modules/timesheets/payPeriods.service.ts");
    const routes = read("src/modules/timesheets/payPeriods.routes.ts");
    expect(read("src/modules/finance/financeEvents.ts")).toContain('AGENCY_TIME_ZONE = "America/Puerto_Rico"');
    expect(timesheets).not.toMatch(/::date \+ interval '1 day'/);
    expect(periods).not.toMatch(/::date\+interval '1 day'/);
    expect(periods).toContain("PAY_PERIOD_OVERLAP");
    expect(routes).toContain("respondInternalError");
    expect(routes).not.toContain('e instanceof Error?e.message:"INTERNAL_ERROR"');
  });

  it("has a guarded rollback that only removes 118", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '118_finance_foundation\.sql';/);
    expect(rollback).not.toMatch(/DELETE FROM schema_migrations[^;]*11[0-7]_/);
    expect(rollback).not.toMatch(/app_record_timesheet_from_checkout/);
  });
});

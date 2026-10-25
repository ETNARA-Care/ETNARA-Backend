import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("ETNARA Finanzas F1 — services and rates (119)", () => {
  const m119 = read("migrations/119_finance_services_rates.sql");
  const m119Code = m119.replace(/--.*$/gm, "");
  const rollback = read("ops/119_finance_services_rates.rollback.sql");
  const service = read("src/modules/finance/finance.service.ts");
  const calc = read("src/modules/finance/financeCalc.ts");

  it("adds tables only: shifts, timesheets and legacy rates are not altered", () => {
    expect(m119Code).not.toMatch(/ALTER TABLE\s+(public\.)?(shifts|timesheets|worker_financial_rates|assignments|audit_log)\b/i);
    expect(m119Code).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\s+(public\.)?(shifts|timesheets|worker_financial_rates|audit_log)\b/i);
    expect(m119Code).not.toMatch(/app_record_timesheet_from_checkout/);
    expect(m119Code).not.toMatch(/DROP TABLE/i);
  });

  it("stores money as integer cents and never uses numeric or float", () => {
    expect(m119).toContain("amount_cents                      integer NOT NULL");
    expect(m119).not.toMatch(/\b(numeric|decimal|real|double precision|float)\b/i);
    expect(calc).not.toMatch(/parseFloat|toFixed|Math\.round|\*\s*0\.01/);
    expect(service).not.toMatch(/parseFloat|toFixed/);
  });

  it("protects every new table: admin of the agency, FINANZAS on for writes, ETNARA central denied, no delete", () => {
    for (const t of ["finance_services", "billing_clients", "billing_client_recipients", "finance_holidays", "finance_rates", "recipient_finance_defaults", "shift_finance_terms"]) {
      expect(m119).toContain(`'${t}'`);
    }
    expect(m119).toContain("public.app_is_org_admin()");
    expect(m119).toContain("public.app_org_feature_enabled(organization_id, ''FINANZAS'')");
    expect(m119).toContain("AS RESTRICTIVE FOR ALL TO app_runtime");
    expect(m119).not.toMatch(/GRANT[^;]*DELETE/);
    expect(m119).toContain("GRANT UPDATE (effective_to, ended_by_user_id, ended_at, end_reason) ON finance_rates TO app_runtime");
  });

  it("keeps rate versions immutable and free of overlaps", () => {
    expect(m119).toContain("FINANCE_RATE_IMMUTABLE");
    expect(m119).toContain("FINANCE_RATE_OVERLAP");
    expect(m119).toContain("pg_advisory_xact_lock");
    expect(m119).toContain("daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')");
    expect(m119).toContain("FINANCE_SERVICE_UNIT_IMMUTABLE");
    expect(m119).toContain("SHIFT_FINANCE_LOCKED");
  });

  it("resolves billing and pay separately with the agreed priority", () => {
    expect(service).toContain("Billing: client's rate for the service → general billing rate.");
    expect(service).toContain("Pay: caregiver's exception for the service → general pay rate.");
    expect(service).toMatch(/resolveLine\(trx, organizationId, service\.id, "client"/);
    expect(service).toMatch(/resolveLine\(trx, organizationId, service\.id, "caregiver"/);
  });

  it("writes values only to finance_events and identifiers to audit_log", () => {
    expect(service).not.toContain("INSERT INTO audit_log");
    expect(service.match(/recordFinanceEvent\(/g)?.length).toBeGreaterThanOrEqual(10);
    expect(service.match(/recordFinancialAudit\(/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it("puts every finance route behind FINANZAS and the write limit", () => {
    const rules = read("src/middleware/orgFeatureRules.ts");
    expect(rules).toContain("finance(/|$)`), feature: \"FINANZAS\"");
    expect(rules).toContain("/finance$`), feature: \"FINANZAS\"");
    expect(read("src/middleware/featureWriteLimit.ts")).toContain("|finance)");
  });

  it("has a guarded rollback that only removes 119", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '119_finance_services_rates\.sql';/);
    expect(rollback).not.toMatch(/DELETE FROM schema_migrations[^;]*11[0-8]_/);
    expect(rollback).not.toMatch(/DROP TABLE IF EXISTS (shifts|timesheets|worker_financial_rates|finance_events)\b/);
  });
});

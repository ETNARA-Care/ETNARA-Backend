import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("ETNARA Finanzas F1.1 — cancel scheduled rates, deactivate holidays (120)", () => {
  const m120 = read("migrations/120_finance_rate_cancel_holiday_deactivate.sql");
  const code = m120.replace(/--.*$/gm, "");
  const rollback = read("ops/120_finance_rate_cancel_holiday_deactivate.rollback.sql");
  const service = read("src/modules/finance/finance.service.ts");
  const routes = read("src/modules/finance/finance.routes.ts");

  it("is additive: no table dropped, no row deleted, shifts/timesheets/legacy rates untouched", () => {
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
    expect(code).not.toMatch(/\b(shifts|timesheets|worker_financial_rates|assignments)\b/i);
    expect(code).not.toMatch(/app_record_timesheet_from_checkout/);
    expect(code).not.toMatch(/GRANT[^;]*DELETE/);
  });

  it("only versions that have not taken effect can be cancelled, and cancelled versions are final", () => {
    expect(m120).toContain("IF OLD.effective_from <= v_today THEN");
    expect(m120).toContain("RAISE EXCEPTION 'FINANCE_RATE_ALREADY_IN_FORCE'");
    expect(m120).toContain("RAISE EXCEPTION 'FINANCE_RATE_CANCELLED'");
    expect(m120).toContain("v_today date := (now() AT TIME ZONE 'America/Puerto_Rico')::date;");
  });

  it("reopens only the version closed by a version cancelled in the same transaction, never past its old end", () => {
    expect(m120).toContain("v_cancelled.cancelled_at <> now()");
    expect(m120).toContain("LEAST(OLD.superseded_previous_to, v_cancelled.effective_to)");
    expect(m120).toContain("NEW.superseded_previous_to IS DISTINCT FROM OLD.effective_to");
  });

  it("cancelled versions never count: overlap check, resolution and lists skip them", () => {
    expect(m120).toContain("AND r.cancelled_at IS NULL");
    expect(service.match(/cancelled_at IS NULL/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it("holidays are deactivated with a reason, never deleted, and inactive ones are ignored", () => {
    expect(m120).toContain("RAISE EXCEPTION 'FINANCE_HOLIDAY_NO_DELETE'");
    expect(m120).toContain("length(btrim(deactivation_reason)) BETWEEN 3 AND 300");
    expect(service).toContain("holiday_date = ${params.date}::date AND active`");
  });

  it("the backfill runs before the deferred self-reference is added", () => {
    expect(m120.indexOf("ALTER TABLE finance_rates ENABLE TRIGGER finance_rates_guard;"))
      .toBeLessThan(m120.indexOf("ADD CONSTRAINT finance_rates_superseded_by_fk"));
  });

  it("new routes require a reason and record values in finance_events, identifiers in audit_log", () => {
    expect(routes).toContain("/rates/:rateId/cancel");
    expect(routes).toContain("/holidays/:date/deactivate");
    expect(service).toContain("export const rateCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });");
    for (const action of ["FINANCE_RATE_CANCELLED", "FINANCE_RATE_REOPENED", "FINANCE_HOLIDAY_DEACTIVATED", "FINANCE_HOLIDAY_REACTIVATED"]) {
      expect(service).toContain(`action: "${action}"`);
    }
  });

  it("cancel and end take the service lock before the rate lock (same order as createRate: no deadlock)", () => {
    for (const fn of ["export async function endRate(", "export async function cancelRate("]) {
      const body = service.slice(service.indexOf(fn), service.indexOf("\n}\n", service.indexOf(fn)));
      expect(body.indexOf("lockServiceOfRate(")).toBeGreaterThan(0);
      expect(body.indexOf("lockServiceOfRate(")).toBeLessThan(body.indexOf("FOR UPDATE"));
    }
    expect(service).toContain('if (e?.code === "40P01" || e?.code === "40001") throw new FinanceError("FINANCE_CONCURRENT_CHANGE", 409);');
  });

  it("rollback refuses to run once anything was cancelled or deactivated", () => {
    expect(rollback).toContain("rollback aborted, nothing changed");
    expect(rollback).toContain("WHERE cancelled_at IS NOT NULL");
  });
});

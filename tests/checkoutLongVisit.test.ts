import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { describeInternalError, logInternalError, sanitizeErrorMessage } from "../src/observability/internalError.js";

const m113 = readFileSync("migrations/113_checkout_long_visit_timesheet_review.sql", "utf8").replace(/--.*$/gm, "");

describe("migration 113: a visit open > 48 h can be finished", () => {
  it("no longer raises for a window longer than 48 h; notifies managers and audits instead", () => {
    expect(m113).toMatch(/IF p_check_out_at <= p_check_in_at THEN\s+RAISE EXCEPTION 'invalid timesheet window';/);
    expect(m113).not.toMatch(/OR extract\(epoch FROM \(p_check_out_at - p_check_in_at\)\) > 172800 THEN\s+RAISE/);
    expect(m113).toMatch(/> 172800 THEN[\s\S]*app_notify_shift_managers\(p_organization_id, p_shift_id, 'TIMESHEET_NEEDS_REVIEW'\)[\s\S]*'TIMESHEET_SKIPPED_LONG_VISIT'[\s\S]*RETURN NULL;/);
  });

  it("keeps the caller checks and the accepted-assignment rule", () => {
    expect(m113).toMatch(/RAISE EXCEPTION 'invalid timesheet context'/);
    expect(m113).toMatch(/RAISE EXCEPTION 'timesheet checkout forbidden'/);
    expect(m113.match(/RAISE EXCEPTION 'accepted assignment required for timesheet'/g)?.length).toBe(2);
  });

  it("grants only to app_runtime and modifies no data", () => {
    expect(m113).not.toMatch(/TO\s+PUBLIC/i);
    expect(m113).toMatch(/GRANT EXECUTE ON FUNCTION app_record_timesheet_from_checkout\([^)]*\) TO app_runtime;/);
    expect(m113).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE)\s+(public\.)?(timesheets|shifts|verification_events|notifications)\b/i);
  });
});

describe("safe logging of unexpected errors", () => {
  it("removes values that could identify a person", () => {
    const msg = sanitizeErrorMessage(
      'duplicate key value violates unique constraint "users_email_key" Key (email)=(ana@example.com) id 5e99a059-eed9-4c93-a618-5c1abc66b5b9 phone 7875551234 \'secret\''
    );
    expect(msg).not.toContain("ana@example.com");
    expect(msg).not.toContain("5e99a059");
    expect(msg).not.toContain("7875551234");
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("users_email_key");
    expect(msg.length).toBeLessThanOrEqual(160);
  });

  it("keeps our own RAISE codes readable", () => {
    expect(sanitizeErrorMessage("invalid timesheet window")).toBe("invalid timesheet window");
  });

  it("logs the route template and SQLSTATE, never detail, where, params or body", () => {
    const err = Object.assign(new Error('null value in column "x"'), {
      code: "23502", constraint: "c1", table: "timesheets", detail: "Failing row contains (Ana Pérez, 787-555-1234)", where: "PL/pgSQL function", hint: "h",
    });
    const req = { method: "POST", baseUrl: "", route: { path: "/organizations/:organizationId/shifts/:shiftId/check-out" },
      params: { organizationId: "febe519d-3504-4488-a741-d962db40be89" }, body: { name: "Ana Pérez" } };
    const d = describeInternalError("verification", err, req as never);
    expect(d.route).toBe("/organizations/:organizationId/shifts/:shiftId/check-out");
    expect(d.code).toBe("23502");
    expect(d.constraint).toBe("c1");
    const line = JSON.stringify(d);
    for (const leaked of ["Ana", "787", "febe519d", "PL/pgSQL", "Failing row"]) expect(line).not.toContain(leaked);
  });

  it("returns a fresh reference id and writes one JSON line", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = logInternalError("verification", new Error("boom"));
    const b = logInternalError("verification", new Error("boom"));
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ errorId: a, event: "INTERNAL_ERROR", scope: "verification", message: "boom" });
    spy.mockRestore();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rollback = readFileSync("ops/110_111_smartmatch_fixes.rollback.sql", "utf8");
const runbook = readFileSync("ops/110_111_smartmatch_fixes.rollback.md", "utf8");
const code = rollback.replace(/--.*$/gm, "");

describe("SmartMatch fixes rollback keeps password_reset_tokens restricted", () => {
  it("never grants to PUBLIC and never unregisters 111", () => {
    expect(code).not.toMatch(/TO\s+PUBLIC/i);
    expect(code).not.toMatch(/DELETE FROM schema_migrations[^;]*111/i);
    expect(code).toMatch(/WHERE filename IN \('110_schedule_commitments_and_overnight_availability\.sql', '112_caregiver_cross_agency_acceptance\.sql'\);/);
  });

  it("checks the privileges before and after, inside one transaction", () => {
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
    expect(code.match(/a\.grantee = 0/g)?.length).toBe(2);
    expect(code).toMatch(/app_runtime lacks SELECT\/INSERT\/UPDATE/);
    expect(code).toMatch(/migration 111 must stay registered/);
  });

  it("the runbook recovers password reset by granting to app_runtime only", () => {
    expect(runbook).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.password_reset_tokens TO app_runtime;/);
    expect(runbook).toMatch(/REVOKE ALL ON public\.password_reset_tokens FROM PUBLIC;/);
    expect(runbook).not.toMatch(/GRANT[^\n]*TO PUBLIC;/);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "migrations/092_smartmatch_agency_opportunity_rls.sql"), "utf8");
const foundation = readFileSync(resolve(process.cwd(), "migrations/090_smartmatch_foundation.sql"), "utf8");

describe("SmartMatch database policy guardrails", () => {
  it("forces RLS on all new tenant-owned tables", () => {
    for (const table of ["smartmatch_opportunities", "smartmatch_applications", "smartmatch_location_preferences"]) {
      expect(foundation).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });
  it("does not grant access to applications or caregiver locations", () => {
    expect(migration).not.toMatch(/GRANT\s+[^;]*ON\s+smartmatch_applications\s+TO\s+app_runtime/i);
    expect(migration).not.toMatch(/GRANT\s+[^;]*ON\s+smartmatch_location_preferences\s+TO\s+app_runtime/i);
  });
  it("restricts opportunity access to organization admin in current tenant", () => {
    expect(migration).toContain("r.code = 'ORGANIZATION_ADMIN'");
    expect(migration).toContain("app.current_org_id");
    expect(migration).toContain("app.current_user_id");
    expect(migration).not.toContain("app_is_superadmin()");
  });
});

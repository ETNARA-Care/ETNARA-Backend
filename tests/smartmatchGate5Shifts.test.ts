import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const m099 = read("migrations/099_smartmatch_shift_link.sql").replace(/--[^\n]*/g, "");
const service = read("src/modules/smartmatch/smartmatch.shifts.service.ts");
const app = read("src/app.ts");

// Static guardrails. Behavior: scripts/verifySmartMatchShifts.ts (30 HTTP + RLS checks).
describe("SmartMatch Gate 5: Crear turno con esta cuidadora", () => {
  it("links at most one shift per opportunity, same agency, only when FILLED, write-once", () => {
    expect(m099).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_smartmatch_opportunities_shift_once\s+ON smartmatch_opportunities \(shift_id\) WHERE shift_id IS NOT NULL/);
    expect(m099).toMatch(/FOREIGN KEY \(shift_id, organization_id\) REFERENCES shifts \(id, organization_id\)/);
    expect(m099).toContain("CHECK (shift_id IS NULL OR status = 'FILLED')");
    expect(m099).toContain("SMARTMATCH_SHIFT_LINK_IMMUTABLE");
  });

  it("keeps private instructions out of shifts: managers and the assigned worker only", () => {
    expect(m099).not.toMatch(/ALTER TABLE shifts/);
    expect(m099).toContain("ALTER TABLE shift_private_instructions FORCE ROW LEVEL SECURITY");
    expect(m099).toContain("app_worker_has_shift_assignment(shift_id)");
    expect(m099).not.toMatch(/family_relationships|DELETE ON shift_private_instructions/i);
    expect(m099).toMatch(/CREATE POLICY platform_phi_deny ON shift_private_instructions\s+AS RESTRICTIVE/);
  });

  it("reuses the Turnos rules instead of a parallel calendar or assignment module", () => {
    expect(service).toContain("insertShiftInTransaction(trx");
    expect(service).toContain("assignWorkerToShiftInTransaction(trx");
    expect(service).not.toMatch(/INSERT INTO (shifts|assignments)\b/);
    expect(read("src/modules/assignments/assignments.service.ts")).toMatch(/assignWorkerToShiftInTransaction\(trx, organizationId, shiftId, input\)/);
  });

  it("schedule and role come from the opportunity; the request cannot change them", () => {
    expect(service).toMatch(/careRecipientId: z\.string\(\)\.uuid\(\),\s+instructions: z\.string\(\)\.trim\(\)\.max\(2000\)\.optional\(\),\s+\}\)\.strict\(\)/);
    expect(service).toContain("scheduledStart: iso(opp.starts_at)");
    expect(service).toContain("requiredRole: opp.role_label");
    expect(service).toMatch(/FOR UPDATE/);
    expect(service).toContain("status = 'active'");
  });

  it("is mounted and verified in CI", () => {
    expect(app).toContain("app.use(smartMatchShiftRoutes)");
    expect(read(".github/workflows/etnara-ci.yml")).toContain("scripts/verifySmartMatchShifts.ts");
    expect(read(".github/workflows/smartmatch-postgres.yml")).toContain("scripts/verifySmartMatchShifts.ts");
  });
});

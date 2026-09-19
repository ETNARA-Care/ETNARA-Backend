import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 7.1 individual care plans", () => {
  it("versions plans instead of overwriting or deleting audit history", () => {
    const service = read("src/modules/carePlans/carePlans.service.ts");
    expect(service).toMatch(/MAX\(version\)/);
    expect(service).toMatch(/status = 'superseded'/);
    expect(service).toMatch(/INSERT INTO care_plans/);
    expect(service).not.toMatch(/DELETE FROM care_plans/);
  });

  it("limits management to managers and reads to managers or assigned workers", () => {
    const service = read("src/modules/carePlans/carePlans.service.ts");
    const migration = read("migrations/049_care_plan_authorization.sql");
    expect(service).toContain("app_is_org_manager()");
    expect(service).toMatch(/a\.response_status IN \('pending', 'accepted'\)/);
    expect(migration).toContain("care_plans_manager_or_assigned_worker_read");
    expect(migration).toContain("care_plans_manager_insert");
    expect(migration).not.toContain("FOR DELETE");
  });

  it("keeps Family off the raw operational care-plan endpoint", () => {
    const service = read("src/modules/carePlans/carePlans.service.ts");
    const routes = read("src/modules/carePlans/carePlans.routes.ts");
    expect(service).not.toContain("family_relationships");
    expect(routes).toContain('"CARE_PLAN_ACCESS_DENIED"');
    expect(routes).not.toContain("family-care-plan");
  });
});

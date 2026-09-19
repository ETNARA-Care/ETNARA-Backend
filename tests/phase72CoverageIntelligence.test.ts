import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 7.2 assisted coverage intelligence", () => {
  it("uses only real eligibility, schedule, continuity, and workload data", () => {
    const service = read("src/modules/coverage/coverage.service.ts");
    expect(service).toContain("evaluateWorkerEligibility");
    expect(service).toContain("has_schedule_conflict");
    expect(service).toContain("continuity_count");
    expect(service).toContain("scheduled_minutes_next_7_days");
    expect(service).not.toMatch(/Math\.random|mock|demo/i);
  });

  it("keeps assignment authority human and manager-only", () => {
    const service = read("src/modules/coverage/coverage.service.ts");
    const routes = read("src/modules/coverage/coverage.routes.ts");
    expect(service).toContain("app_is_org_manager()");
    expect(routes).toContain("/coverage/recommendations");
    expect(service).not.toContain("INSERT INTO assignments");
    expect(service).not.toContain("UPDATE assignments");
  });

  it("never recommends an ineligible worker or a schedule conflict", () => {
    const service = read("src/modules/coverage/coverage.service.ts");
    expect(service).toContain('eligibility.eligibilityStatus === "eligible"');
    expect(service).toContain("isEligible && !worker.has_schedule_conflict");
    expect(service).toContain("Tiene otro turno que coincide con este horario");
  });
});

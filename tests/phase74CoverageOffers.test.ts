import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 7.4 collaborative open-shift coverage", () => {
  it("stores tenant-scoped campaigns and self-scoped offers", () => {
    const migration = read("migrations/052_open_shift_coverage_offers.sql");
    expect(migration).toContain("coverage_campaigns");
    expect(migration).toContain("coverage_offers");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("app.current_user_id");
  });
  it("sends only a safe work window and never grants resident access", () => {
    const service = read("src/modules/coverageOffers/coverageOffers.service.ts");
    expect(service).toContain("scheduledStart");
    expect(service).toContain("roleLabel");
    expect(service).not.toContain("preferred_name");
    expect(service).not.toContain("care_plans");
  });
  it("records interest without auto-assigning", () => {
    const service = read("src/modules/coverageOffers/coverageOffers.service.ts");
    expect(service).toContain('"interested"');
    expect(service).not.toContain("INSERT INTO assignments");
  });
  it("closes pending offers when Administration makes the final assignment", () => {
    const assignments = read("src/modules/assignments/assignments.service.ts");
    expect(assignments).toContain("WITH closed_campaigns AS");
    expect(assignments).toContain("response_status = 'withdrawn'");
  });
});

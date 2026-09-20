import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Phase 7.3 worker-declared availability", () => {
  it("stores weekly windows and bounded time off under tenant RLS", () => {
    const migration = read("migrations/050_worker_availability.sql");
    expect(migration).toContain("worker_availability_settings");
    expect(migration).toContain("worker_weekly_availability");
    expect(migration).toContain("worker_unavailability_periods");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("app.current_user_id");
  });

  it("allows only the authenticated linked worker to replace self availability", () => {
    const service = read("src/modules/availability/availability.service.ts");
    const routes = read("src/modules/availability/availability.routes.ts");
    expect(service).toMatch(/w\.user_id = \$\{userId\}/);
    expect(service).toMatch(/owm\.organization_id = \$\{organizationId\}/);
    expect(routes).toContain("/me/availability");
    expect(routes).toContain("requireAuth");
  });

  it("blocks recommendations outside declared availability without auto-assigning", () => {
    const coverage = read("src/modules/coverage/coverage.service.ts");
    expect(coverage).toContain("worker_weekly_availability");
    expect(coverage).toContain("worker_unavailability_periods");
    expect(coverage).toContain("matchesDeclaredAvailability");
    expect(coverage).toContain("El turno está fuera de su disponibilidad semanal");
    expect(coverage).not.toContain("INSERT INTO assignments");
  });
});

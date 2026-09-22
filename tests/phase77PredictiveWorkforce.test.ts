import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 7.7 predictive workforce planning", () => {
  it("stores a bounded required role on every shift", () => {
    const migration = read("migrations/057_predictive_workforce_planning.sql");
    const scheduling = read("src/modules/scheduling/scheduling.service.ts");
    const offers = read("src/modules/coverageOffers/coverageOffers.service.ts");
    expect(migration).toContain("required_role");
    expect(migration).toContain("shifts_required_role_nonempty");
    expect(scheduling).toContain("requiredRole: z.string().trim().min(1).max(80)");
    expect(scheduling).toContain('input.requiredRole ?? "Cuidador/a"');
    expect(offers).toContain("${shift.required_role}");
  });

  it("keeps the forecast manager-only and tenant-scoped", () => {
    const service = read("src/modules/workforcePlanning/workforcePlanning.service.ts");
    const routes = read("src/modules/workforcePlanning/workforcePlanning.routes.ts");
    expect(service).toContain("app_is_org_manager()");
    expect(service).toContain("withTenantContext({ userId, organizationId }");
    expect(routes).toContain("/organizations/:organizationId/workforce/forecast");
    expect(routes).toContain("WORKFORCE_PLANNING_FORBIDDEN");
  });

  it("uses real demand, eligibility, availability and expirations without auto-assignment", () => {
    const service = read("src/modules/workforcePlanning/workforcePlanning.service.ts");
    expect(service).toContain("evaluateWorkerEligibility");
    expect(service).toContain("worker_weekly_availability");
    expect(service).toContain("worker_unavailability_periods");
    expect(service).toContain("latest_credentials");
    expect(service).toContain("coverageGapMinutes");
    expect(service).not.toContain("INSERT INTO assignments");
    expect(service).not.toContain("UPDATE assignments");
  });

  it("accepts only the supported planning horizons", () => {
    const service = read("src/modules/workforcePlanning/workforcePlanning.service.ts");
    expect(service).toContain("[7, 14, 30].includes(value)");
    expect(service).toContain("pg_timezone_names");
  });
});

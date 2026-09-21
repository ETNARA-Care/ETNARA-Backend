import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Phase 7.6.2 compliance self-service", () => {
  it("selects the most specific requirement set for the worker role", () => {
    const service = read("src/modules/eligibility/eligibility.service.ts");
    expect(service).toContain("lower(worker_role) = lower(${workerRole})");
    expect(service).toContain("ORDER BY (worker_role IS NOT NULL) DESC");
    expect(service).toContain("membership.internal_role");
  });

  it("keeps policy changes manager-only in both service and RLS", () => {
    const service = read("src/modules/eligibility/eligibility.service.ts");
    const migration = read("migrations/056_compliance_policy_manager_authority.sql");
    expect(service).toContain("assertComplianceManager");
    expect(service).toContain("app_is_org_manager()");
    expect(migration.match(/app_is_org_manager\(\)/g)?.length).toBeGreaterThanOrEqual(6);
    expect(migration).toContain("OR app_is_superadmin()");
  });

  it("exposes configuration and append-only audit history without accepting eligibility", () => {
    const routes = read("src/modules/eligibility/eligibility.routes.ts");
    const service = read("src/modules/eligibility/eligibility.service.ts");
    expect(routes).toContain('"/organizations/:organizationId/compliance/configuration"');
    expect(routes).toContain('"/organizations/:organizationId/compliance/audit"');
    expect(service).toContain("COMPLIANCE_REQUIREMENTS_UPDATED");
    expect(service).toContain("INSERT INTO audit_log");
    expect(routes).not.toMatch(/eligibilityStatus.*req\.body/);
  });
});

import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("Phase 10.0 multi-agency establishments", () => {
  it("keeps every query inside the selected organization tenant", () => {
    const service = read("src/modules/establishments/establishments.service.ts");
    expect(service).toContain("withTenantContext({ userId, organizationId }");
    expect(service.match(/organization_id = \$\{organizationId\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(service).toContain("SELECT app_is_org_manager() AS is_manager");
  });

  it("exposes authenticated manager endpoints without a destructive delete route", () => {
    const routes = read("src/modules/establishments/establishments.routes.ts");
    expect(routes).toContain('/organizations/:organizationId/establishments');
    expect(routes).toContain("requireAuth");
    expect(routes).not.toMatch(/router\.delete/i);
  });

  it("enforces tenant checks and manager write authority in PostgreSQL", () => {
    const migration = read("migrations/065_establishment_manager_authority.sql");
    expect(migration).toContain("locations_member_read");
    expect(migration).toContain("locations_manager_insert");
    expect(migration).toContain("locations_manager_update");
    expect(migration.match(/app_is_org_manager\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("WITH CHECK");
    expect(migration).toContain("REVOKE DELETE ON locations FROM app_runtime");
  });

  it("preserves an audit trail for establishment changes", () => {
    const service = read("src/modules/establishments/establishments.service.ts");
    expect(service).toContain("INSERT INTO audit_log");
    expect(service).toContain("ESTABLISHMENT_CREATED");
    expect(service).toContain("ESTABLISHMENT_UPDATED");
    expect(service).not.toMatch(/DELETE FROM locations/i);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.8 credential management", () => {
  it("serves the database-backed credential type catalog to authenticated organization members", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const routes = read("src/modules/credentialing/credentialing.routes.ts");

    expect(service).toContain("FROM credential_types");
    expect(service).toContain("withTenantContext({ userId, organizationId }");
    expect(routes).toContain('"/organizations/:organizationId/credential-types"');
    expect(routes).toContain("requireAuth");
  });

  it("keeps credential creation and updates bound to the selected worker", () => {
    const service = read("src/modules/credentialing/credentialing.service.ts");
    const updateStart = service.indexOf("UPDATE credentials");
    const setClause = service.slice(updateStart, service.indexOf("WHERE", updateStart));

    expect(service).toContain("await assertWorkerLinkedToOrg");
    expect(service).toContain("WHERE id = ${credentialId} AND worker_id = ${workerId}");
    expect(setClause).not.toMatch(/\bworker_id\s*=/);
  });
});

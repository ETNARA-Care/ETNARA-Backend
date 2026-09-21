import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("authenticated caregiver identity", () => {
  it("resolves the worker profile from the authenticated user inside a validated tenant", () => {
    const service = read("src/modules/organizationContext/organizationContext.service.ts");
    const routes = read("src/modules/organizationContext/organizationContext.routes.ts");
    expect(service).toContain("withTenantContext({ userId, organizationId }");
    expect(service).toContain("WHERE w.user_id = ${userId}");
    expect(service).toContain("owm.organization_id = ${organizationId}");
    expect(routes).toContain('"/organizations/:organizationId/me/worker-profile"');
    expect(routes).toContain("requireAuth");
    expect(service).not.toContain('displayName: "María Rivera"');
  });
});

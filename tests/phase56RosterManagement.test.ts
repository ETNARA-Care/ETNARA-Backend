import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.6 organization roster management", () => {
  it("creates named worker profiles and preserves membership history", () => {
    const service = read("src/modules/workforce/workforce.service.ts");

    expect(service).toContain("displayName: z.string().trim().min(1).max(120)");
    expect(service).toMatch(/INSERT INTO workers \(id, display_name\)/);
    expect(service).toContain('status: z.enum(["active", "inactive"])');
    expect(service).not.toMatch(/DELETE FROM (workers|organization_worker_memberships)/);
  });

  it("restricts worker roster mutations to organization managers", () => {
    const service = read("src/modules/workforce/workforce.service.ts");
    const routes = read("src/modules/workforce/workforce.routes.ts");

    expect(service).toMatch(/SELECT app_is_org_manager\(\) AS is_manager/);
    expect(service).toContain("await assertWorkforceManager(trx)");
    expect(routes).toContain('res.status(403).json({ error: "WORKFORCE_MANAGEMENT_FORBIDDEN" })');
  });

  it("archives residents through their existing status contract rather than deleting rows", () => {
    const service = read("src/modules/careRecipients/careRecipients.service.ts");

    expect(service).toContain('status: z.enum(["active", "archived"])');
    expect(service).toMatch(/UPDATE care_recipients/);
    expect(service).toMatch(/archived_at =/);
    expect(service).not.toMatch(/DELETE FROM care_recipients/);
  });
});

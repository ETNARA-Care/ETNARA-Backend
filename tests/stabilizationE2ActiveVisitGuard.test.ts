import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Pre-pilot E.2 active visit unassignment guard", () => {
  it("blocks removal when check-in has no later check-out", () => {
    const service = read("src/modules/assignments/auditableRemoval.service.ts");
    const guardAt = service.indexOf("AssignmentHasActiveVisitError");
    const auditAt = service.indexOf("INSERT INTO assignment_removal_audit");
    const deleteAt = service.indexOf("DELETE FROM assignments");
    expect(guardAt).toBeGreaterThan(-1);
    expect(service).toContain("check_in.event_type = 'check_in'");
    expect(service).toContain("check_out.event_type = 'check_out'");
    expect(service).toContain("check_out.occurred_at > check_in.occurred_at");
    expect(service.indexOf("if (activeVisit.rows[0]) throw new AssignmentHasActiveVisitError()" )).toBeLessThan(auditAt);
    expect(auditAt).toBeLessThan(deleteAt);
  });

  it("returns a conflict code the UI can handle", () => {
    const routes = read("src/modules/assignments/assignments.routes.ts");
    expect(routes).toContain("AssignmentHasActiveVisitError");
    expect(routes).toContain('res.status(409).json({ error: "ASSIGNMENT_HAS_ACTIVE_VISIT" })');
  });
});

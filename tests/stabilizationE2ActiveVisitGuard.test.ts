import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const servicePath = fileURLToPath(
  new URL("../src/modules/assignments/auditableRemoval.service.ts", import.meta.url)
);
const routesPath = fileURLToPath(
  new URL("../src/modules/assignments/assignments.routes.ts", import.meta.url)
);
const serviceSource = readFileSync(servicePath, "utf8");
const routesSource = readFileSync(routesPath, "utf8");

describe("E.2 active visit unassignment guard", () => {
  it("checks for an unmatched check-in before writing audit history or deleting the assignment", () => {
    const guardIndex = serviceSource.indexOf("const activeVisit");
    const auditIndex = serviceSource.indexOf("INSERT INTO assignment_removal_audit");
    const deleteIndex = serviceSource.indexOf("DELETE FROM assignments");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(serviceSource).toContain("check_in.event_type = 'check_in'");
    expect(serviceSource).toContain("check_out.event_type = 'check_out'");
    expect(serviceSource).toContain("throw new AssignmentHasActiveVisitError()");
    expect(guardIndex).toBeLessThan(auditIndex);
    expect(guardIndex).toBeLessThan(deleteIndex);
  });

  it("maps an active visit to an explicit 409 API conflict", () => {
    expect(routesSource).toContain("AssignmentHasActiveVisitError");
    expect(routesSource).toContain('res.status(409).json({ error: "ASSIGNMENT_HAS_ACTIVE_VISIT" })');
  });
});

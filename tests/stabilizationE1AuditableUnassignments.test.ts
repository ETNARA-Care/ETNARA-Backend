import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Pre-pilot E.1 auditable unassignments", () => {
  it("stores immutable tenant-scoped removal history", () => {
    const migration = read("migrations/067_assignment_removal_audit.sql");
    expect(migration).toContain("CREATE TABLE assignment_removal_audit");
    expect(migration).toContain("removed_by_user_id");
    expect(migration).toContain("removal_reason text NOT NULL");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FOR SELECT");
    expect(migration).toContain("FOR INSERT");
    expect(migration).not.toMatch(/FOR UPDATE/);
    expect(migration).not.toMatch(/FOR DELETE/);
  });

  it("audits before deleting and requires a reason", () => {
    const service = read("src/modules/assignments/auditableRemoval.service.ts");
    const insertAt = service.indexOf("INSERT INTO assignment_removal_audit");
    const deleteAt = service.indexOf("DELETE FROM assignments");
    expect(insertAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(insertAt);
    expect(service).toContain("AssignmentRemovalReasonRequiredError");
    expect(service).toContain("FOR UPDATE");
    expect(service).toContain("removed_by_user_id");
    expect(service).toContain("${removalReason}");
  });

  it("routes all administrative removals through the audited service", () => {
    const routes = read("src/modules/assignments/assignments.routes.ts");
    expect(routes).toContain("removeAssignmentAudited");
    expect(routes).toContain("ASSIGNMENT_REMOVAL_REASON_REQUIRED");
    expect(routes).not.toMatch(/\bremoveAssignment\(/);
  });
});

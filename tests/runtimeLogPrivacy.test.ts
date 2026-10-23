import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("runtime log privacy", () => {
  it("keeps assignment and scheduling diagnostics bounded", () => {
    const assignments = read("src/modules/assignments/assignments.routes.ts");
    const scheduling = read("src/modules/scheduling/scheduling.routes.ts");
    const assignmentService = read("src/modules/assignments/assignments.service.ts");

    for (const source of [assignments, scheduling, assignmentService]) {
      expect(source).not.toContain("message: error.message");
      expect(source).not.toContain("error.message}");
      expect(source).not.toContain("${error.name}: ${error.message}");
    }

    expect(assignments).toContain("databaseCode");
    expect(scheduling).toContain("databaseCode");
    expect(assignmentService).toContain("Assignment accepted but messaging synchronization failed");
  });

  it("does not log raw errors in platform or establishment runtime routes", () => {
    const platform = read("src/modules/platformOrganizations/platformOrganizations.routes.ts");
    const establishments = read("src/modules/establishments/establishments.routes.ts");

    expect(platform).not.toContain("message:error.message");
    expect(platform).toContain('{name:error.name}');

    expect(establishments).not.toContain("candidate?.message");
    expect(establishments).toContain('name:candidate?.name??"UnknownError"');
  });

  it("does not emit raw PostgreSQL error objects from the runtime pool", () => {
    const db = read("src/config/db.ts");
    expect(db).not.toContain('console.error("Unexpected PostgreSQL pool error on idle client", err)');
    expect(db).toContain('name: err.name');
    expect(db).toContain('code: typeof');
  });

  it("has no dedicated bulk export endpoints in the application router", () => {
    const app = read("src/app.ts");
    expect(app).not.toMatch(/csv|xlsx|spreadsheet/i);
    expect(app).not.toMatch(/exportRoutes|reportsRoutes/);
  });
});

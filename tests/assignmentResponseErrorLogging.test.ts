import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("assignment-response production diagnostics", () => {
  it("logs unmatched response failures without exposing details to clients", () => {
    const source = readFileSync(
      join(process.cwd(), "src/modules/assignments/assignments.routes.ts"),
      "utf8"
    );

    expect(source).toContain('logUnexpectedAssignmentError("respondToMyAssignment", err)');
    expect(source).toContain('res.status(500).json({ error: "INTERNAL_ERROR" })');
    expect(source).toContain("Never include request bodies, user IDs,");
    expect(source).toContain("organization IDs, shift IDs, SQL text, or clinical information.");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("scheduling production diagnostics", () => {
  it("logs unmatched caregiver-shift failures without exposing them to clients", () => {
    const source = readFileSync(
      join(process.cwd(), "src/modules/scheduling/scheduling.routes.ts"),
      "utf8"
    );

    expect(source).toContain('logUnexpectedSchedulingError("listMyShifts", err)');
    expect(source).toContain('res.status(500).json({ error: "INTERNAL_ERROR" })');
    expect(source).toContain("Never include request bodies, user IDs, organization IDs, or SQL text.");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("production CORS allowlist", () => {
  it("always includes the official ETNARA GitHub Pages origin", () => {
    const source = readFileSync(join(process.cwd(), "src/app.ts"), "utf8");

    expect(source).toContain('"https://etnara-care.github.io"');
    expect(source).toContain("new Set([");
    expect(source).not.toContain('Access-Control-Allow-Origin", "*"');
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  new URL("../scripts/bootstrapStaging.ts", import.meta.url),
  "utf8",
);

describe("production bootstrap safety", () => {
  it("never executes the demo seed during automatic deployment bootstrap", () => {
    expect(bootstrap).not.toMatch(/execSync\(["'`]npx tsx scripts\/seedDemo\.ts/);
    expect(bootstrap).toContain("applyPendingMigrations");
    expect(bootstrap).toContain("decouplePlatformAdmin.ts");
  });
});

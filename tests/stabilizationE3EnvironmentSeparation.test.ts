import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("E.3 production and staging separation", () => {
  it("never bootstraps or seeds demo data from the production start command", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    const start = packageJson.scripts?.start ?? "";
    expect(start).toBe("tsx src/index.ts");
    expect(start).not.toMatch(/bootstrap|seed|demo/i);
  });

  it("keeps staging bootstrap explicit and separate", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["start:staging"]).toMatch(/^npm run bootstrap:staging && /);
    expect(packageJson.scripts?.["bootstrap:staging"]).toBe("tsx scripts/bootstrapStaging.ts");
  });

  it("keeps demo seeding confined to the staging bootstrap", () => {
    const stagingBootstrap = read("scripts/bootstrapStaging.ts");
    expect(stagingBootstrap).toMatch(/seedDemo\.ts/);
  });
});

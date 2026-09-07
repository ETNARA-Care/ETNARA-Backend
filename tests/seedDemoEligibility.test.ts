import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("demo shift eligibility bootstrap", () => {
  it("creates an idempotent requirement set scoped to the demo organization", () => {
    const seed = readFileSync(join(root, "scripts/seedDemo.ts"), "utf8");
    expect(seed).toMatch(/SELECT id FROM requirement_sets WHERE organization_id = \$1 AND name = \$2 LIMIT 1/);
    expect(seed).toMatch(/INSERT INTO requirement_sets \(organization_id, organization_type, name\)/);
    expect(seed).not.toMatch(/INSERT INTO requirement_sets \(organization_id, organization_type, name\)[\s\S]*VALUES \(NULL/);
  });
});

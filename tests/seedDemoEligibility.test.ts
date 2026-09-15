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
    expect(seed).toMatch(/mandatoryCredentialTypes/);
    expect(seed).toMatch(/INSERT INTO requirements/);
    expect(seed).toMatch(/NOT EXISTS \([\s\S]*requirement_set_id = \$1/);
    expect(seed).toContain('"BACKGROUND_CHECK"');
    expect(seed).toContain('"LEY_300"');
    expect(seed).toContain('"CPR"');
    expect(seed).toContain('"BLS"');
  });

  it("seeds verified credentials idempotently for María", () => {
    const seed = readFileSync(join(root, "scripts/seedDemo.ts"), "utf8");
    expect(seed).toMatch(/ensureDemoCredential/);
    expect(seed).toMatch(/credential_platform_verifications/);
    expect(seed).toMatch(/"CPR", "external_provider", 45/);
    expect(seed).toMatch(/Dato ficticio para validar el portal demo/);
  });
});

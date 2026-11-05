import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Decisión 4-nov-2026: cada agencia define los requisitos de cada puesto; ETNARA no impone
// una lista universal. Solo cambia el MOTIVO mostrado; la regla de aprobación no cambia.
describe("eligibility by agency policy", () => {
  const service = read("src/modules/eligibility/eligibility.service.ts");
  const evaluation = service.slice(service.indexOf("export async function evaluateWorkerEligibilityInTransaction"), service.indexOf("async function persistEligibility"));

  it("only an approved agency review satisfies a reviewed requirement; a rejection has its own reason", () => {
    expect(evaluation).toMatch(/if \(reviewStatus === "rejected"\) \{\s*reason = "ORGANIZATION_REVIEW_REJECTED";\s*\} else if \(reviewStatus !== "approved"\) \{\s*reason = "ORGANIZATION_REVIEW_MISSING";\s*\} else \{\s*satisfied = true;/);
  });

  it("without an applicable policy there is nothing to evaluate: the evaluation throws (no universal fallback written)", () => {
    expect(service).toContain("throw new NoApplicableRequirementSetError();");
    expect(read("src/modules/eligibility/eligibility.routes.ts")).toContain('eligibility: "unconfigured"');
    expect(read("src/modules/assignments/assignments.service.ts")).toMatch(/eligibility\.eligibilityStatus !== "eligible"[\s\S]*throw new WorkerNotEligibleError/);
  });

  it("the compliance agent explains what to do after a rejection", () => {
    expect(service).toMatch(/ORGANIZATION_REVIEW_REJECTED[\s\S]*solicitar un documento nuevo/);
  });
});

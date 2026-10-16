import { describe, expect, it } from "vitest";
import { validateRepairPrIntent, REPAIR_GITHUB_WRITE_ENABLED, REPAIR_PR_AUTOMATION_ENABLED } from "./repairPrPreflight.js";
const valid = { agentId: "technology-2", repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded", branch: "repair/backend-health-01" };
describe("repair PR preflight", () => {
  it("allows a bounded, non-executing request", () => {
    expect(validateRepairPrIntent(valid)).toMatchObject({ dryRun: true, approvalRequired: true, pullRequestCreated: false });
    expect(REPAIR_GITHUB_WRITE_ENABLED).toBe(false);
    expect(REPAIR_PR_AUTOMATION_ENABLED).toBe(false);
  });
  it("rejects unknown agents, repositories, signals and extra fields", () => {
    expect(validateRepairPrIntent({ ...valid, agentId: "technology-4" })).toBeNull();
    expect(validateRepairPrIntent({ ...valid, repository: "unapproved/repo" })).toBeNull();
    expect(validateRepairPrIntent({ ...valid, signal: "unknown" })).toBeNull();
    expect(validateRepairPrIntent({ ...valid, extra: true })).toBeNull();
    expect(validateRepairPrIntent(null)).toBeNull();
  });
  it("rejects invalid branch names", () => {
    expect(validateRepairPrIntent({ ...valid, branch: "main" })).toBeNull();
    expect(validateRepairPrIntent({ ...valid, branch: "repair/../main" })).toBeNull();
  });
});

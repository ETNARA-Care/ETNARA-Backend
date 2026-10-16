import { describe, expect, it } from "vitest";
import { buildReadOnlyRepairPlan } from "./repairPlanPilot.js";
describe("Tower repair planning pilot", () => {
  it("returns bounded, non-executing playbooks for LEO", () => {
    for (const signal of ["frontend_unavailable", "database_unavailable", "backend_degraded"]) {
      const plan = buildReadOnlyRepairPlan("technology-2", signal);
      expect(plan?.suggestedChecks.length).toBeGreaterThan(0);
      expect(plan?.pullRequestCreated).toBe(false);
      expect(plan?.changesApplied).toBe(false);
      expect(plan?.deploymentTriggered).toBe(false);
      expect(plan?.nextStep).toBe("human_review_required");
    }
  });
  it("denies other agents and arbitrary signals", () => {
    expect(buildReadOnlyRepairPlan("technology-4", "frontend_unavailable")).toBeNull();
    expect(buildReadOnlyRepairPlan("technology-3", "database_unavailable")).toBeNull();
    expect(buildReadOnlyRepairPlan("technology-2", "__proto__")).toBeNull();
    expect(buildReadOnlyRepairPlan("technology-2", "delete_records")).toBeNull();
  });
});

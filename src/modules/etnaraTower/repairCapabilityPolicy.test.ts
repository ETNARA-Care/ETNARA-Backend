import { describe, expect, it } from "vitest";
import { canAgentPrepareRepair, REPAIR_AUTONOMOUS_DEPLOY_ENABLED, REPAIR_AUTONOMOUS_MERGE_ENABLED } from "./repairCapabilityPolicy.js";

describe("Tower agent repair capability policy", () => {
  it("allows only explicitly assigned diagnostic and preparation permissions", () => {
    expect(canAgentPrepareRepair("technology-4", "diagnose")).toBe(true);
    expect(canAgentPrepareRepair("technology-3", "diagnose")).toBe(true);
    expect(canAgentPrepareRepair("technology-2", "prepare_pull_request")).toBe(true);
    expect(canAgentPrepareRepair("technology-2", "propose_patch")).toBe(true);
    expect(canAgentPrepareRepair("technology-4", "prepare_pull_request")).toBe(false);
  });
  it("denies critical actions and unlisted agents", () => {
    for (const agent of ["technology-2", "technology-3", "technology-4", "__proto__", ""]) {
      for (const action of ["merge", "deploy", "change_secrets", "modify_patient_data"] as const) {
        expect(canAgentPrepareRepair(agent, action)).toBe(false);
      }
    }
    expect(canAgentPrepareRepair("executive-1", "diagnose")).toBe(false);
    expect(REPAIR_AUTONOMOUS_MERGE_ENABLED).toBe(false);
    expect(REPAIR_AUTONOMOUS_DEPLOY_ENABLED).toBe(false);
  });
});

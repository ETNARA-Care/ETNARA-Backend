import { describe, expect, it } from "vitest";
import { validateRepairPatchProposal } from "./repairPatchGuard.js";
const request = {
  agentId: "technology-2", branch: "repair/tower-health-01",
  repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded",
  paths: ["src/modules/etnaraTower/liveHealthCollector.ts"],
};
describe("repair patch path guard", () => {
  it("accepts only allowlisted files without authorizing a write", () => {
    expect(validateRepairPatchProposal(request)).toMatchObject({
      accepted: true, readyToApply: false, approvalRequired: true,
    });
  });
  it("rejects sensitive and unknown paths", () => {
    for (const paths of [[".env"], ["src/context/tenantContext.ts"], ["../secrets"],
      ["src/modules/etnaraTower/liveHealthCollector.ts", "src/modules/etnaraTower/liveHealthCollector.ts"], []]) {
      expect(validateRepairPatchProposal({ ...request, paths })).toBeNull();
    }
  });
  it("rejects extra fields and other agents", () => {
    expect(validateRepairPatchProposal({ ...request, content: "arbitrary patch" })).toBeNull();
    expect(validateRepairPatchProposal({ ...request, agentId: "technology-4" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { validateVersionedRepairProposal } from "./versionedRepairProposal.js";
const valid = {
  agentId: "technology-2", branch: "repair/tower-health-01",
  repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded",
  files: [{ path: "src/modules/etnaraTower/liveHealthCollector.ts", expectedBlobSha: "a".repeat(40) }],
};
describe("versioned repair proposal", () => {
  it("combines repo, path and SHA checks without applying changes", () => {
    expect(validateVersionedRepairProposal(valid)).toMatchObject({
      dryRun: true, readyToApply: false, approvalRequired: true,
    });
  });
  it("rejects unknown paths, agents and malformed versions", () => {
    expect(validateVersionedRepairProposal({ ...valid, agentId: "technology-4" })).toBeNull();
    expect(validateVersionedRepairProposal({ ...valid, files: [{ path: ".env", expectedBlobSha: "a".repeat(40) }] })).toBeNull();
    expect(validateVersionedRepairProposal({ ...valid, files: [{ path: "src/modules/etnaraTower/liveHealthCollector.ts", expectedBlobSha: "invalid" }] })).toBeNull();
    expect(validateVersionedRepairProposal({ ...valid, extra: true })).toBeNull();
  });
});

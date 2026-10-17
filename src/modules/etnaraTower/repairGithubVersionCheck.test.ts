import { describe, expect, it } from "vitest";
import { compareRepairProposalToGithubMetadata } from "./repairGithubVersionCheck.js";
const path = "src/modules/etnaraTower/liveHealthCollector.ts";
const proposal = { agentId: "technology-2", branch: "repair/tower-health-01",
  repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded",
  files: [{ path, expectedBlobSha: "a".repeat(40) }] };
describe("repair GitHub file version comparison", () => {
  it("recognizes matching metadata but never authorizes writes", () => {
    expect(compareRepairProposalToGithubMetadata(proposal, [{ path, blobSha: "a".repeat(40) }]))
      .toEqual({ status: "match", readyToApply: false, approvalRequired: true });
  });
  it("blocks stale, missing, duplicate and malformed metadata", () => {
    expect(compareRepairProposalToGithubMetadata(proposal, [{ path, blobSha: "b".repeat(40) }]).status).toBe("stale");
    expect(compareRepairProposalToGithubMetadata(proposal, []).status).toBe("incomplete");
    expect(compareRepairProposalToGithubMetadata(proposal, [{ path, blobSha: "a".repeat(40) }, { path, blobSha: "a".repeat(40) }]).status).toBe("incomplete");
    expect(compareRepairProposalToGithubMetadata(proposal, [{ path, blobSha: "invalid" }]).status).toBe("invalid");
    expect(compareRepairProposalToGithubMetadata({ ...proposal, agentId: "technology-4" }, [{ path, blobSha: "a".repeat(40) }]).status).toBe("invalid");
  });
});

import { describe, expect, it, vi } from "vitest";
import { runRepairGithubVersionPreflight } from "./repairGithubVersionPreflight.js";
const path = "src/modules/etnaraTower/liveHealthCollector.ts";
const input = { agentId: "technology-2", branch: "repair/tower-health-01",
  repository: "ETNARA-Care/ETNARA-Backend", signal: "backend_degraded",
  files: [{ path, expectedBlobSha: "a".repeat(40) }] };
const token = "example-token-for-tests";
describe("GitHub live repair version preflight", () => {
  it("checks current blob metadata without enabling writes", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () =>
      ({ type: "file", path, sha: "a".repeat(40) }) } as Response));
    expect(await runRepairGithubVersionPreflight(input, token, fetcher)).toEqual({
      status: "match", readyToApply: false, approvalRequired: true, githubWriteEnabled: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects stale versions and unavailable tokens", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () =>
      ({ type: "file", path, sha: "b".repeat(40) }) } as Response));
    expect((await runRepairGithubVersionPreflight(input, token, fetcher)).status).toBe("stale");
    expect((await runRepairGithubVersionPreflight(input, undefined, fetcher)).status).toBe("unavailable");
    expect((await runRepairGithubVersionPreflight({ ...input, agentId: "technology-4" }, token, fetcher)).status).toBe("invalid");
  });
});

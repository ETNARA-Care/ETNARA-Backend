import { describe, expect, it, vi } from "vitest";
import { collectGithubActionsObservation } from "../src/modules/etnaraTower/githubCollector.js";
const checkedAt = "2026-10-16T17:00:00Z";
const signal = new AbortController().signal;
describe("ETNARA Tower GitHub read-only collector", () => {
  it("collects latest successful CI with fixed URL and GET", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ workflow_runs: [{ status: "completed", conclusion: "success" }] }) }));
    const observation = await collectGithubActionsObservation({ token: "test-token", fetcher, checkedAt, signal });
    expect(observation.health).toBe("healthy");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/ETNARA-Backend/actions/runs?");
    expect(JSON.stringify(observation)).not.toContain("test-token");
  });
  it("returns unknown for failed API requests", async () => {
    const observation = await collectGithubActionsObservation({ token: "test", fetcher: async () => ({ ok: false, json: async () => ({}) }), checkedAt, signal });
    expect(observation.health).toBe("unknown");
  });
  it("does not call the API without a token", async () => {
    const fetcher = vi.fn();
    const observation = await collectGithubActionsObservation({ token: "", fetcher, checkedAt, signal });
    expect(observation.health).toBe("unknown");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("treats transport exceptions as unknown, not healthy", async () => {
    const observation = await collectGithubActionsObservation({ token: "test", fetcher: async () => { throw new Error("secret"); }, checkedAt, signal });
    expect(observation.health).toBe("unknown");
    expect(observation.summary).not.toContain("secret");
  });
});

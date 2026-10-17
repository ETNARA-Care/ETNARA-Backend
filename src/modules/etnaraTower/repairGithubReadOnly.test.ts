import { describe, expect, it, vi } from "vitest";
import { fetchRepairGithubBlobMetadata } from "./repairGithubReadOnly.js";
const repo = "ETNARA-Care/ETNARA-Backend";
const path = "src/modules/etnaraTower/liveHealthCollector.ts";
const token = "example-token-for-tests";
describe("read-only GitHub blob metadata", () => {
  it("requests only allowlisted file metadata from GitHub", async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => ({ ok: true, json: async () => ({
      type: "file", path, sha: "a".repeat(40),
    }) } as Response));
    expect(await fetchRepairGithubBlobMetadata(repo, [path], token, fetcher))
      .toEqual({ status: "ok", files: [{ path, blobSha: "a".repeat(40) }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toContain("api.github.com/repos/");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("fails closed on invalid paths, missing credentials or unexpected responses", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
      type: "file", path, sha: "invalid",
    }) } as Response));
    expect((await fetchRepairGithubBlobMetadata(repo, [".env"], token, fetcher)).status).toBe("invalid");
    expect((await fetchRepairGithubBlobMetadata(repo, [path], undefined, fetcher)).status).toBe("unavailable");
    expect((await fetchRepairGithubBlobMetadata(repo, [path], token, fetcher)).status).toBe("unavailable");
  });
});

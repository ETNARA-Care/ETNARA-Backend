import { describe, expect, it, vi } from "vitest";
import { collectLeoGithubMetadata } from "../src/modules/etnaraTower/leoGithubMetadata.js";

describe("LEO bounded GitHub metadata", () => {
  it("returns no source content and only allowlisted file metadata", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      return { ok: true, json: async () => ({ type: "file", path, sha: "a".repeat(40), content: "SECRET_SOURCE_SHOULD_NOT_LEAK" }) };
    });
    const result = await collectLeoGithubMetadata("x".repeat(30), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toContain('"status":"verified"');
    expect(result).not.toContain("SECRET_SOURCE_SHOULD_NOT_LEAK");
    expect(result).not.toContain('"content"');
  });
  it("fails closed when read token is missing", async () => {
    const fetcher = vi.fn();
    const result = await collectLeoGithubMetadata(undefined, fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toContain('"status":"unavailable"');
  });
});

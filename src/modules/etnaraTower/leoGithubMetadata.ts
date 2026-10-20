import { fetchRepairGithubBlobMetadata } from "./repairGithubReadOnly.js";

const targets = [
  { repository: "ETNARA-Care/ETNARA-Backend", paths: [
    "src/modules/etnaraTower/liveHealthCollector.ts",
    "src/modules/etnaraTower/tower.routes.ts",
  ] },
  { repository: "ETNARA-Care/ETNARAMVP", paths: [
    "frontend-v23/src/pages/platform/PlatformTowerPage.tsx",
  ] },
] as const;

/** Only allowlisted file paths and immutable blob hashes. No source contents, secrets or tenant data. */
export async function collectLeoGithubMetadata(token: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
  const entries = [];
  for (const target of targets) {
    const result = await fetchRepairGithubBlobMetadata(target.repository, target.paths, token, fetcher);
    entries.push(result.status === "ok"
      ? { repository: target.repository, status: "verified", files: result.files }
      : { repository: target.repository, status: "unavailable", files: [] });
  }
  return JSON.stringify({
    source: "server-side GitHub read-only allowlisted file metadata",
    checkedAt: new Date().toISOString(),
    repositories: entries,
    limitations: "Only three allowlisted file blob SHAs are checked; no source code, tests, PR status, deployment or repository-wide health is verified.",
  });
}

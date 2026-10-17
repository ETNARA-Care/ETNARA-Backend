/** Read-only GitHub file metadata adapter for the Tower repair pilot.
 * Requires a narrowly scoped token supplied by server-side configuration.
 * Never accepts arbitrary repository URLs or performs writes.
 */
const repositories = new Set(["ETNARA-Care/ETNARA-Backend", "ETNARA-Care/ETNARAMVP"]);
const allowedPaths: Record<string, ReadonlySet<string>> = {
  "ETNARA-Care/ETNARA-Backend": new Set([
    "src/modules/etnaraTower/liveHealthCollector.ts",
    "src/modules/etnaraTower/tower.routes.ts",
  ]),
  "ETNARA-Care/ETNARAMVP": new Set([
    "frontend-v23/src/pages/platform/PlatformTowerPage.tsx",
  ]),
};
export interface GithubBlobMetadata { path: string; blobSha: string }
export type GithubMetadataResult =
  | { status: "ok"; files: readonly GithubBlobMetadata[] }
  | { status: "unavailable" | "invalid" };

export async function fetchRepairGithubBlobMetadata(
  repository: string,
  paths: readonly string[],
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<GithubMetadataResult> {
  if (!repositories.has(repository) || !Array.isArray(paths) || paths.length < 1 ||
      paths.length > 3 || new Set(paths).size !== paths.length ||
      paths.some(path => !allowedPaths[repository]?.has(path))) return { status: "invalid" };
  if (!token || !/^[\x21-\x7e]{10,512}$/.test(token)) return { status: "unavailable" };
  const files: GithubBlobMetadata[] = [];
  for (const path of paths) {
    const url = `https://api.github.com/repos/${repository}/contents/${path}?ref=main`;
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) return { status: "unavailable" };
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "unavailable" };
      const data = value as Record<string, unknown>;
      if (data.type !== "file" || data.path !== path ||
          typeof data.sha !== "string" || !/^[a-f0-9]{40}$/.test(data.sha)) return { status: "unavailable" };
      files.push({ path, blobSha: data.sha });
    } catch {
      return { status: "unavailable" };
    }
  }
  return { status: "ok", files };
}

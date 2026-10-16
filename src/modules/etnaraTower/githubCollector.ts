import { githubWorkflowObservation } from "./providerSnapshots.js";
import type { TowerHealthObservation } from "./observability.js";

/** Narrow network dependency for testability. Never log or return credentials or API payloads. */
export type TowerFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface GithubTowerCollectorOptions {
  token: string;
  fetcher: TowerFetch;
  checkedAt: string;
  signal: AbortSignal;
}

/** Fixed ETNARA repository, read-only GitHub Actions endpoint; no arbitrary URL input. */
export async function collectGithubActionsObservation(options: GithubTowerCollectorOptions): Promise<TowerHealthObservation> {
  const unknown = (): TowerHealthObservation => ({
    service: "backend", environment: "ci", checkedAt: options.checkedAt,
    health: "unknown", source: "github-actions", summary: "CI status unavailable",
  });
  if (!options.token.trim()) return unknown();
  try {
    const response = await options.fetcher(
      "https://api.github.com/repos/ETNARA-Care/ETNARA-Backend/actions/runs?branch=main&per_page=1",
      { method: "GET", headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }, signal: options.signal },
    );
    if (!response.ok) return unknown();
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("workflow_runs" in body)) return unknown();
    const runs = (body as { workflow_runs?: unknown }).workflow_runs;
    if (!Array.isArray(runs) || runs.length === 0) return unknown();
    const run: unknown = runs[0];
    if (!run || typeof run !== "object" || !("status" in run)) return unknown();
    const status = (run as { status?: unknown }).status;
    const conclusion = (run as { conclusion?: unknown }).conclusion;
    if (typeof status !== "string") return unknown();
    return githubWorkflowObservation({
      status,
      conclusion: typeof conclusion === "string" ? conclusion : null,
    }, options.checkedAt);
  } catch {
    return unknown();
  }
}

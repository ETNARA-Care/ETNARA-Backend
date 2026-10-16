import type { TowerHealthObservation, TowerService } from "./observability.js";

/** Read-only Railway deployment summary. Never pass logs, secrets or user records. */
export interface RailwayDeploymentSnapshot {
  status: string;
  createdAt: string;
  serviceName: string;
}
export interface TowerSnapshot {
  observations: TowerHealthObservation[];
  collectedAt: string;
}
const healthy = new Set(["SUCCESS"]);
const pending = new Set(["WAITING", "QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING", "NEEDS_APPROVAL"]);
const failed = new Set(["FAILED", "CRASHED"]);
export function classifyRailwayDeployment(
  deployment: RailwayDeploymentSnapshot | null,
  service: TowerService = "backend",
  now: string = new Date().toISOString(),
): TowerHealthObservation {
  const status = deployment?.status.toUpperCase() ?? "UNKNOWN";
  const health = healthy.has(status) ? "healthy" : failed.has(status) ? "unavailable" : pending.has(status) ? "degraded" : "unknown";
  return {
    service,
    environment: "production",
    checkedAt: now,
    health,
    source: "railway-deployment",
    summary: health === "unknown" ? "No conclusive deployment status" : health === "healthy" ? "Latest deployment succeeded" : health === "degraded" ? "Deployment is in progress" : "Latest deployment failed",
  };
}
/** GitHub Actions status is independent evidence, not a live service health check. */
export function classifyGithubCI(conclusion: string | null): "passing" | "failing" | "pending" | "unknown" {
  if (conclusion === "success") return "passing";
  if (conclusion === "failure" || conclusion === "timed_out") return "failing";
  if (conclusion === null) return "pending";
  return "unknown";
}

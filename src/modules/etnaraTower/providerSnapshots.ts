import type { TowerHealthObservation } from "./observability.js";
import { classifyRailwayDeployment } from "./readOnlyAdapters.js";

/** Sanitized provider input; the caller must supply data obtained with read-only access. */
export interface RailwayServiceState {
  name: string;
  state: "online" | "crashed" | "sleeping" | "deploying" | "waiting" | "offline" | string;
  deploymentStatus: string | null;
}
export interface GithubWorkflowState {
  conclusion: string | null;
  status: "completed" | "in_progress" | "queued" | string;
}
/** Do not infer uptime from a successful deployment or CI run. */
export function railwayServiceObservation(
  service: RailwayServiceState | null,
  checkedAt: string,
): TowerHealthObservation {
  if (!service) return { service: "backend", environment: "production", checkedAt, health: "unknown", source: "railway-service-state", summary: "No service state available" };
  const health = service.state === "online" ? "healthy"
    : service.state === "crashed" || service.state === "offline" ? "unavailable"
    : service.state === "deploying" || service.state === "waiting" ? "degraded" : "unknown";
  return { service: "backend", environment: "production", checkedAt, health, source: "railway-service-state",
    summary: health === "healthy" ? "Service reported online" : health === "unavailable" ? "Service reported offline" : health === "degraded" ? "Service transition in progress" : "Service status unconfirmed" };
}
export function railwayDeploymentObservation(status: string | null, checkedAt: string): TowerHealthObservation {
  return classifyRailwayDeployment(status ? { status, createdAt: "", serviceName: "backend" } : null, "backend", checkedAt);
}
/** GitHub workflow failures are warnings, not proof that production is unavailable. */
export function githubWorkflowObservation(workflow: GithubWorkflowState | null, checkedAt: string): TowerHealthObservation {
  const health = !workflow || workflow.status !== "completed" ? "unknown"
    : workflow.conclusion === "success" ? "healthy"
    : workflow.conclusion === "failure" || workflow.conclusion === "timed_out" ? "degraded" : "unknown";
  return { service: "backend", environment: "ci", checkedAt, health, source: "github-actions",
    summary: health === "healthy" ? "CI completed successfully" : health === "degraded" ? "CI failed" : "CI status unconfirmed" };
}

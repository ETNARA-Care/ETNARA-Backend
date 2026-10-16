import { canAgentPrepareRepair } from "./repairCapabilityPolicy.js";
import type { RepairSignal } from "./repairPlanPilot.js";

/** Safe preflight for future GitHub PR automation.
 * Validates intent only; never contacts GitHub or performs writes.
 */
export const REPAIR_GITHUB_WRITE_ENABLED = false as const;
export const REPAIR_PR_AUTOMATION_ENABLED = false as const;
const repositories = ["ETNARA-Care/ETNARA-Backend", "ETNARA-Care/ETNARAMVP"] as const;
const signals: readonly RepairSignal[] = ["frontend_unavailable", "database_unavailable", "backend_degraded"];
export interface RepairPrIntent {
  agentId: "technology-2";
  repository: typeof repositories[number];
  signal: RepairSignal;
  branch: string;
  approvalRequired: true;
  dryRun: true;
  pullRequestCreated: false;
}
export function validateRepairPrIntent(input: unknown): RepairPrIntent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).sort().join(",") !== "agentId,branch,repository,signal") return null;
  if (obj.agentId !== "technology-2" || !canAgentPrepareRepair(obj.agentId, "prepare_pull_request")) return null;
  if (typeof obj.repository !== "string" || !repositories.some(repo => repo === obj.repository)) return null;
  if (typeof obj.signal !== "string" || !signals.some(signal => signal === obj.signal)) return null;
  if (typeof obj.branch !== "string" || !/^repair\/[a-z0-9][a-z0-9-]{2,48}$/.test(obj.branch)) return null;
  return {
    agentId: "technology-2", repository: obj.repository as RepairPrIntent["repository"],
    signal: obj.signal as RepairSignal, branch: obj.branch,
    approvalRequired: true, dryRun: true, pullRequestCreated: false,
  };
}

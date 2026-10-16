import { TOWER_CORPORATE_AGENTS } from "./corporateRoster.js";

export type CorporateTaskStatus = "draft" | "submitted" | "in_review" | "approved" | "rejected" | "completed";
export type CorporateTaskPriority = "low" | "normal" | "high";
export interface CorporateTaskRequest {
  agentId: string;
  title: string;
  instructions: string;
  priority: CorporateTaskPriority;
}
export interface CorporateTaskTransition {
  from: CorporateTaskStatus;
  to: CorporateTaskStatus;
  approvedByPlatformAdmin: boolean;
}
const permitted: Readonly<Record<CorporateTaskStatus, readonly CorporateTaskStatus[]>> = {
  draft: ["submitted"],
  submitted: ["in_review", "rejected"],
  in_review: ["approved", "rejected"],
  approved: ["completed"],
  rejected: [],
  completed: [],
};
/** Workflow policy only; no persistence, model calls, or action execution. */
export function validateCorporateTaskRequest(request: CorporateTaskRequest): boolean {
  return TOWER_CORPORATE_AGENTS.some(agent => agent.id === request.agentId) &&
    request.title.trim().length >= 3 && request.title.length <= 120 &&
    request.instructions.trim().length >= 5 && request.instructions.length <= 1500 &&
    ["low", "normal", "high"].includes(request.priority);
}
export function mayTransitionCorporateTask(change: CorporateTaskTransition): boolean {
  if (!permitted[change.from].includes(change.to)) return false;
  if (change.to === "approved" || change.to === "completed") return change.approvedByPlatformAdmin;
  return true;
}
export const CORPORATE_TASK_EXECUTION_ENABLED = false as const;

/** ETNARA Tower phase 11.2: pure, side-effect-free agent catalog and task policy. */
export const TOWER_AGENT_IDS = ["cto", "software-engineer", "systems-engineer", "sre", "cybersecurity"] as const;
export type TowerAgentId = (typeof TOWER_AGENT_IDS)[number];
export type TowerRisk = "low" | "medium" | "high";
export type TowerTaskStatus = "queued" | "running" | "needs_approval" | "completed" | "failed";

export interface TowerAgentDefinition {
  id: TowerAgentId;
  name: string;
  responsibilities: readonly string[];
  allowedReadScopes: readonly string[];
}

export const TOWER_AGENTS: readonly TowerAgentDefinition[] = [
  { id: "cto", name: "Chief Technology Officer", responsibilities: ["triage", "coordination", "approval-request"], allowedReadScopes: ["incident-metadata", "audit-events"] },
  { id: "software-engineer", name: "Software Engineer", responsibilities: ["code-diagnosis", "test-proposal", "patch-proposal"], allowedReadScopes: ["repository-metadata", "sanitized-errors"] },
  { id: "systems-engineer", name: "Systems Engineer", responsibilities: ["infrastructure-diagnosis", "deployment-analysis"], allowedReadScopes: ["deployment-status", "dns-metadata", "sanitized-errors"] },
  { id: "sre", name: "Site Reliability Engineer", responsibilities: ["healthchecks", "availability-analysis", "incident-detection"], allowedReadScopes: ["health-status", "sanitized-errors"] },
  { id: "cybersecurity", name: "Cybersecurity Engineer", responsibilities: ["access-review", "tenant-isolation-review", "change-risk-review"], allowedReadScopes: ["audit-events", "security-findings"] },
];

export type TowerAction =
  | "read-observability"
  | "read-repository"
  | "read-infrastructure"
  | "propose-change"
  | "write-code"
  | "deploy"
  | "rollback"
  | "change-dns"
  | "change-access"
  | "run-migration";

export function towerActionRequiresApproval(action: TowerAction): boolean {
  return action !== "read-observability" &&
    action !== "read-repository" &&
    action !== "read-infrastructure" &&
    action !== "propose-change";
}

export interface TowerTask {
  incidentId: string;
  agentId: TowerAgentId;
  status: TowerTaskStatus;
  environment: string;
  risk: TowerRisk;
  evidenceRefs: readonly string[];
  approvalRef?: string;
}

/** No executor is exposed: integrations and approval enforcement belong to later phases. */
export function mayExecuteTowerAction(action: TowerAction, approvalRef?: string): boolean {
  if (towerActionRequiresApproval(action)) return false;
  return !approvalRef || approvalRef.length > 0;
}

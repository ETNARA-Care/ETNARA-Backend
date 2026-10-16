import type { TowerAgentId, TowerRisk, TowerTaskStatus } from "./agentCatalog.js";

export interface TowerIncident {
  id: string;
  title: string;
  environment: string;
  risk: TowerRisk;
  status: "open" | "investigating" | "mitigated" | "resolved";
  evidenceRefs: readonly string[];
}

export interface TowerTaskRecord {
  id: string;
  incidentId: string;
  assignedAgent: TowerAgentId;
  status: TowerTaskStatus;
  action: "investigate" | "propose-fix" | "review-security" | "verify-recovery";
  evidenceRefs: readonly string[];
}

export type TowerAuditEvent = Readonly<{
  taskId: string;
  actor: TowerAgentId | "human";
  event: "created" | "started" | "approval-requested" | "completed" | "failed";
  timestamp: string;
}>;

/** In-memory planning helper only; never a production persistence or authorization layer. */
export function planTowerIncident(
  incident: TowerIncident,
  tasks: readonly TowerTaskRecord[],
): { incident: TowerIncident; tasks: readonly TowerTaskRecord[] } {
  if (!incident.id.trim() || !incident.environment.trim()) {
    throw new Error("Incident requires an id and environment");
  }
  if (tasks.some((task) => task.incidentId !== incident.id)) {
    throw new Error("Tasks must belong to the incident");
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("Duplicate task ids");
  }
  return { incident: { ...incident, evidenceRefs: [...incident.evidenceRefs] }, tasks: tasks.map((task) => ({ ...task, evidenceRefs: [...task.evidenceRefs] })) };
}

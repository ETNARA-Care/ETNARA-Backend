import type { CorporateTaskPriority, CorporateTaskStatus } from "./corporateTaskPolicy.js";

/** Public metadata contract for a future platform-only task service. */
export interface TowerCorporateTaskRecord {
  id: string;
  agentId: string;
  title: string;
  priority: CorporateTaskPriority;
  status: CorporateTaskStatus;
  createdAt: string;
  updatedAt: string;
  createdByPlatformUserId: string;
  approvalByPlatformUserId?: string;
  approvalAt?: string;
}
export interface TowerCorporateTaskAuditEvent {
  taskId: string;
  from: CorporateTaskStatus | null;
  to: CorporateTaskStatus;
  actorPlatformUserId: string;
  at: string;
  reason?: string;
}
/** No DB schema or endpoint is installed yet. These shapes define the review boundary. */
export function isTowerCorporateTaskTerminal(status: CorporateTaskStatus): boolean {
  return status === "rejected" || status === "completed";
}

import type { CorporateTaskPriority, CorporateTaskStatus } from "./corporateTaskPolicy.js";
import type { CorporateTaskAuditEvent } from "./corporateTaskAudit.js";

/** Platform-owned tasks. These records must never be stored in an agency tenant schema. */
export interface CorporateTaskRecord {
  id: string;
  agentId: string;
  title: string;
  instructions: string;
  priority: CorporateTaskPriority;
  status: CorporateTaskStatus;
  createdByPlatformAdminId: string;
  createdAt: string;
  updatedAt: string;
}

/** Server-side authenticated platform principal; never accepted from request JSON. */
export interface TowerPlatformPrincipal {
  userId: string;
  isPlatformAdmin: true;
}

/** Repository contract only: no in-memory fake persistence or active database adapter. */
export interface CorporateTaskRepository {
  create(task: CorporateTaskRecord, principal: TowerPlatformPrincipal): Promise<CorporateTaskRecord>;
  findById(taskId: string, principal: TowerPlatformPrincipal): Promise<CorporateTaskRecord | null>;
  list(principal: TowerPlatformPrincipal, options: { agentId?: string; limit: number }): Promise<readonly CorporateTaskRecord[]>;
  transition(
    taskId: string,
    expectedStatus: CorporateTaskStatus,
    nextStatus: CorporateTaskStatus,
    auditEvent: CorporateTaskAuditEvent,
    principal: TowerPlatformPrincipal,
  ): Promise<CorporateTaskRecord | null>;
}

/** Enforce a bounded page size before any database query is built. */
export function normalizeCorporateTaskLimit(value: number): number | null {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

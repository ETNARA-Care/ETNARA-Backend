import { mayTransitionCorporateTask, type CorporateTaskStatus } from "./corporateTaskPolicy.js";

/** Immutable audit-event contract for a future database-backed corporate task center. */
export interface CorporateTaskAuditEvent {
  taskId: string;
  from: CorporateTaskStatus;
  to: CorporateTaskStatus;
  actorId: string;
  actorIsPlatformAdmin: boolean;
  occurredAt: string;
  reason?: string;
}

/** Validation only. Authentication must resolve actor identity server-side, never from client input. */
export function validateCorporateTaskAuditEvent(event: CorporateTaskAuditEvent): boolean {
  if (!event.taskId.trim() || event.taskId.length > 128 ||
      !event.actorId.trim() || event.actorId.length > 128) return false;
  if (!Number.isFinite(Date.parse(event.occurredAt)) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.occurredAt)) return false;
  if (event.reason !== undefined && event.reason.length > 1000) return false;
  if ((event.to === "approved" || event.to === "rejected" || event.to === "completed") &&
      !event.actorIsPlatformAdmin) return false;
  return mayTransitionCorporateTask({
    from: event.from,
    to: event.to,
    approvedByPlatformAdmin: event.actorIsPlatformAdmin,
  });
}

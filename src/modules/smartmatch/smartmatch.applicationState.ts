/**
 * SmartMatch application decision state machine.
 *
 * A decision is a proposal, not an assignment. The database service must
 * re-check tenant authority, credentials, availability, and vacancy inside
 * the same transaction before approving and creating an assignment.
 */
export type SmartMatchApplicationStatus =
  | "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN"
  /** Opportunity cancelled or expired (migration 109); set by the database, never by an action. */
  | "CLOSED";

export type SmartMatchApplicationAction =
  | "APPROVE" | "REJECT" | "WITHDRAW";

export function nextSmartMatchApplicationStatus(
  current: SmartMatchApplicationStatus,
  action: SmartMatchApplicationAction,
  isAgencyManager: boolean,
  isApplicant: boolean,
): SmartMatchApplicationStatus | null {
  if (current !== "PENDING") return null;
  if (action === "WITHDRAW") return isApplicant ? "WITHDRAWN" : null;
  if (!isAgencyManager) return null;
  return action === "APPROVE" ? "APPROVED" : "REJECTED";
}

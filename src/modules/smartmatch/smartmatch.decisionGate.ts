import { nextSmartMatchApplicationStatus, type SmartMatchApplicationAction, type SmartMatchApplicationStatus } from "./smartmatch.applicationState.js";

/**
 * Pure preflight only. The final approval MUST re-check these conditions
 * under database transaction locks and tenant RLS before assigning a shift.
 * No authorization, assignment or database writes happen here.
 */
export interface SmartMatchDecisionPreflight {
  currentStatus: SmartMatchApplicationStatus;
  action: SmartMatchApplicationAction;
  isAgencyManager: boolean;
  isApplicant: boolean;
  sameOrganization: boolean;
  credentialVerified: boolean;
  scheduleAvailable: boolean;
  opportunityPublished: boolean;
  opportunityStillOpen: boolean;
  shiftVacant: boolean;
  explicitConsent: boolean;
}

export type SmartMatchDecisionResult =
  | { allowed: true; nextStatus: SmartMatchApplicationStatus }
  | { allowed: false; reason: "FORBIDDEN" | "INVALID_TRANSITION" | "INELIGIBLE" };

export function evaluateSmartMatchDecision(input: SmartMatchDecisionPreflight): SmartMatchDecisionResult {
  if (!input.sameOrganization) return { allowed: false, reason: "FORBIDDEN" };
  const nextStatus = nextSmartMatchApplicationStatus(
    input.currentStatus, input.action, input.isAgencyManager, input.isApplicant,
  );
  if (!nextStatus) return { allowed: false, reason: "INVALID_TRANSITION" };
  if (input.action === "APPROVE" && !(
    input.credentialVerified &&
    input.scheduleAvailable &&
    input.opportunityPublished &&
    input.opportunityStillOpen &&
    input.shiftVacant &&
    input.explicitConsent
  )) return { allowed: false, reason: "INELIGIBLE" };
  return { allowed: true, nextStatus };
}

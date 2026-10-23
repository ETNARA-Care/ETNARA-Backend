import { describe, expect, it } from "vitest";
import { evaluateSmartMatchDecision as evaluate } from "../src/modules/smartmatch/smartmatch.decisionGate.js";
import type { SmartMatchDecisionPreflight } from "../src/modules/smartmatch/smartmatch.decisionGate.js";

const valid: SmartMatchDecisionPreflight = {
  currentStatus: "PENDING",
  action: "APPROVE",
  isAgencyManager: true,
  isApplicant: false,
  sameOrganization: true,
  credentialVerified: true,
  scheduleAvailable: true,
  opportunityPublished: true,
  opportunityStillOpen: true,
  shiftVacant: true,
  explicitConsent: true,
};

describe("SmartMatch agency decision preflight", () => {
  it("permits eligible approval proposals, never creates an assignment", () => {
    expect(evaluate(valid)).toEqual({ allowed: true, nextStatus: "APPROVED" });
  });

  it("denies cross-agency decisions even when the reviewer is a manager", () => {
    expect(evaluate({ ...valid, sameOrganization: false })).toEqual({
      allowed: false, reason: "FORBIDDEN",
    });
  });

  it("denies approval if any required safety gate is missing", () => {
    for (const key of [
      "credentialVerified", "scheduleAvailable", "opportunityPublished",
      "opportunityStillOpen", "shiftVacant", "explicitConsent",
    ] as const) {
      expect(evaluate({ ...valid, [key]: false })).toEqual({
        allowed: false, reason: "INELIGIBLE",
      });
    }
  });

  it("requires agency manager and prevents duplicate decisions", () => {
    expect(evaluate({ ...valid, isAgencyManager: false })).toEqual({
      allowed: false, reason: "INVALID_TRANSITION",
    });
    expect(evaluate({ ...valid, currentStatus: "APPROVED" })).toEqual({
      allowed: false, reason: "INVALID_TRANSITION",
    });
  });

  it("allows applicant withdrawal but denies manager impersonation", () => {
    expect(evaluate({ ...valid, action: "WITHDRAW", isAgencyManager: false, isApplicant: true }))
      .toEqual({ allowed: true, nextStatus: "WITHDRAWN" });
    expect(evaluate({ ...valid, action: "WITHDRAW", isApplicant: false }))
      .toEqual({ allowed: false, reason: "INVALID_TRANSITION" });
  });

  it("allows agency manager rejection without requiring approval-only eligibility", () => {
    expect(evaluate({
      ...valid, action: "REJECT", credentialVerified: false, shiftVacant: false,
    })).toEqual({ allowed: true, nextStatus: "REJECTED" });
  });
});

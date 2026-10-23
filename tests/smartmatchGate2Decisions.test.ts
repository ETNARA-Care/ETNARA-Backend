import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { smartMatchApplySchema, smartMatchDecisionSchema, SMARTMATCH_CONSENT_VERSION } from "../src/modules/smartmatch/smartmatch.applications.schemas.js";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const service = read("src/modules/smartmatch/smartmatch.applications.service.ts");
const m096 = read("migrations/096_smartmatch_decisions_and_reapply.sql").replace(/--[^\n]*/g, "");

// Static guardrails. Behavior is proven by scripts/verifySmartMatchDecisions.ts
// (HTTP + real PostgreSQL + concurrency) and scripts/verifySmartMatchRls.ts.
describe("SmartMatch Gate 2: decisions and re-apply", () => {
  it("requires explicit consent with the current text version", () => {
    expect(smartMatchApplySchema.safeParse({ consent: true, consentVersion: SMARTMATCH_CONSENT_VERSION }).success).toBe(true);
    expect(smartMatchApplySchema.safeParse({ consent: false, consentVersion: SMARTMATCH_CONSENT_VERSION }).success).toBe(false);
    expect(smartMatchApplySchema.safeParse({ consent: true }).success).toBe(false);
    expect(smartMatchApplySchema.safeParse({ consent: true, consentVersion: "old" }).success).toBe(false);
    expect(smartMatchApplySchema.safeParse({ consent: true, consentVersion: SMARTMATCH_CONSENT_VERSION, caregiverUserId: "x" }).success).toBe(false);
  });

  it("requires confirmation to approve and accepts no client-supplied checks", () => {
    expect(smartMatchDecisionSchema.safeParse({ decision: "APPROVE" }).success).toBe(false);
    expect(smartMatchDecisionSchema.safeParse({ decision: "APPROVE", confirm: true }).success).toBe(true);
    expect(smartMatchDecisionSchema.safeParse({ decision: "APPROVE", confirm: true, checks: { approvable: true } }).success).toBe(false);
    expect(smartMatchDecisionSchema.safeParse({ decision: "REJECT" }).success).toBe(true);
    expect(smartMatchDecisionSchema.safeParse({ decision: "ASSIGN" }).success).toBe(false);
  });

  it("locks the opportunity before the application and recomputes checks under the lock", () => {
    const decide = service.slice(service.indexOf("export async function decideSmartMatchApplication"));
    const oppLock = decide.indexOf("FROM smartmatch_opportunities");
    const appLock = decide.indexOf("FROM smartmatch_applications\n      WHERE id = ${applicationId} AND organization_id = ${organizationId}\n      FOR UPDATE");
    expect(oppLock).toBeGreaterThan(-1);
    expect(appLock).toBeGreaterThan(oppLock);
    expect(decide.slice(oppLock, appLock)).toContain("FOR UPDATE");
    expect(decide.indexOf("computeApprovalChecks")).toBeGreaterThan(appLock);
    expect(decide).toContain("status = 'FILLED'");
    expect(decide).not.toMatch(/INSERT INTO assignments/);
  });

  it("evaluates credentials fresh inside the decision transaction", () => {
    expect(service).toContain("evaluateWorkerEligibilityInTransaction(trx,");
    expect(service).not.toMatch(/FROM worker_eligibility/);
  });

  it("keeps one open application per caregiver and an immutable history", () => {
    expect(m096).toContain("WHERE status <> 'WITHDRAWN'");
    expect(m096).toMatch(/CREATE CONSTRAINT TRIGGER trg_smartmatch_application_opportunity_open[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
    expect(m096).toContain("SMARTMATCH_EVENTS_APPEND_ONLY");
    expect(m096).toMatch(/GRANT SELECT ON smartmatch_application_events TO app_runtime/);
    expect(m096).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*smartmatch_application_events/);
  });

  it("does not record SmartMatch decisions in audit_log (readable by all org members)", () => {
    expect(service).not.toContain("audit_log");
    expect(m096).not.toMatch(/INSERT INTO (public\.)?audit_log/);
  });
});

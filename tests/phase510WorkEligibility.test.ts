import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.10 work eligibility", () => {
  it("keeps assignment and check-in fail-closed on fresh eligibility", () => {
    const assignments = read("src/modules/assignments/assignments.service.ts");
    const verification = read("src/modules/verification/verification.service.ts");

    expect(assignments).toMatch(/evaluateWorkerEligibility[\s\S]*eligibilityStatus !== "eligible"/);
    expect(verification).toMatch(/export async function checkIn[\s\S]*evaluateWorkerEligibility[\s\S]*eligibilityStatus !== "eligible"/);
  });

  it("reports revoked mandatory credentials distinctly", () => {
    const eligibility = read("src/modules/eligibility/eligibility.service.ts");

    expect(eligibility).toContain('status = \'revoked\'');
    expect(eligibility).toContain('reason = "CREDENTIAL_REVOKED"');
    expect(eligibility).toContain("isMandatory: r.isMandatory");
  });

  it("audits active and inactive membership transitions without deleting history", () => {
    const workforce = read("src/modules/workforce/workforce.service.ts");

    expect(workforce).toContain("WORKER_MEMBERSHIP_STATUS_CHANGED");
    expect(workforce).toMatch(/INSERT INTO audit_log/);
    expect(workforce).toMatch(/previous_value, new_value/);
    expect(workforce).not.toMatch(/DELETE FROM organization_worker_memberships/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),"utf8");

describe("caregiver eligibility ownership",()=>{
  it("does not require ETNARA Platform verification for private caregiver credentials",()=>{
    const eligibility=read("src/modules/eligibility/eligibility.service.ts");
    const evaluation=eligibility.slice(
      eligibility.indexOf("export async function evaluateWorkerEligibility"),
      eligibility.indexOf("async function persistEligibility"),
    );
    expect(evaluation).not.toContain("credential_platform_verifications");
    expect(evaluation).not.toContain("PLATFORM_VERIFICATION_MISSING");
    expect(evaluation).not.toContain("PLATFORM_VERIFICATION_REJECTED");
  });

  it("requires the agency decision when the compliance policy requires organization review",()=>{
    const eligibility=read("src/modules/eligibility/eligibility.service.ts");
    expect(eligibility).toMatch(
      /req\.requires_organization_review[\s\S]*organization_credential_reviews[\s\S]*organization_id = \$\{organizationId\}[\s\S]*review_status = 'approved'/
    );
    expect(eligibility).toContain('reason = "ORGANIZATION_REVIEW_MISSING"');
  });

  it("lets an active, non-expired credential satisfy a policy that does not require organization review",()=>{
    const eligibility=read("src/modules/eligibility/eligibility.service.ts");
    expect(eligibility).toMatch(
      /else if \(req\.requires_organization_review\)[\s\S]*else \{[\s\S]*satisfied = true;[\s\S]*reason = "OK";/
    );
  });

  it("keeps historical platform verification schema but removes it from runtime eligibility authority",()=>{
    const historical=read("migrations/055_platform_credential_verification_queue.sql");
    const privacy=read("tests/phase76PlatformVerification.test.ts");
    expect(historical).toContain("credential_platform_verifications");
    expect(privacy).toContain("removing runtime platform inspection");
  });
});

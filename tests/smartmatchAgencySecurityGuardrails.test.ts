import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { smartMatchPublishSchema } from "../src/modules/smartmatch/smartmatch.schemas.js";

const service = readFileSync(resolve(process.cwd(), "src/modules/smartmatch/smartmatch.service.ts"), "utf8");
const routes = readFileSync(resolve(process.cwd(), "src/modules/smartmatch/smartmatch.routes.ts"), "utf8");

const sample = {
  visibility: "INTERNAL",
  regionLabel: "San Juan",
  roleLabel: "Cuidador",
  startsAt: "2026-11-21T12:00:00.000Z",
  endsAt: "2026-11-21T16:00:00.000Z",
};

describe("SmartMatch agency security regression guardrails", () => {
  it("rejects patient identifiers, addresses and clinical data in published metadata", () => {
    for (const forbidden of [
      { patientName: "Synthetic Patient" },
      { patientId: "00000000-0000-4000-8000-000000000001" },
      { exactAddress: "123 Test Street" },
      { diagnosis: "Synthetic condition" },
      { carePlan: "Synthetic care plan" },
    ]) {
      expect(smartMatchPublishSchema.safeParse({ ...sample, ...forbidden }).success).toBe(false);
    }
  });

  it("rejects invalid dates and does not silently accept extra properties", () => {
    expect(smartMatchPublishSchema.safeParse({ ...sample, endsAt: sample.startsAt }).success).toBe(false);
    expect(smartMatchPublishSchema.safeParse({ ...sample, organizationId: "override" }).success).toBe(false);
  });

  it("requires agency admin for list and publish operations", () => {
    const list = service.slice(service.indexOf("export async function listAgencyOpportunities"), service.indexOf("export async function activateInternalOpportunity"));
    const publish = service.slice(service.indexOf("export async function activateInternalOpportunity"), service.indexOf("async function requireSmartMatchAgencyAdmin"));
    expect(list).toContain("await requireSmartMatchAgencyAdmin(trx, userId, organizationId)");
    expect(publish).toContain("await requireSmartMatchAgencyAdmin(trx, userId, organizationId)");
    expect(routes.match(/error instanceof SmartMatchForbiddenError/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("does not use privileged platform context for agency operations", () => {
    expect(service).not.toContain("withPlatformContext");
    expect(service).toContain("withTenantContext");
  });
});

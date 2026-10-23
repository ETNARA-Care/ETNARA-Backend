import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");
const m097 = strip(read("migrations/097_smartmatch_opportunity_integrity.sql"));
const service = read("src/modules/smartmatch/smartmatch.service.ts");

// Static guardrails. Behavior: scripts/verifySmartMatchRls.ts (G1-G14) and
// scripts/verifySmartMatchTwoAgencyFlow.ts (two agencies, real HTTP).
describe("SmartMatch Gate 3: opportunity integrity and publishing", () => {
  it("enforces the status machine with a trigger that binds every writer", () => {
    expect(m097).toMatch(/CREATE TRIGGER trg_smartmatch_opportunity_transition\s+BEFORE UPDATE ON smartmatch_opportunities/);
    expect(m097).toContain("OLD.status = 'DRAFT'     AND NEW.status IN ('PUBLISHED', 'CANCELLED')");
    expect(m097).toContain("OLD.status = 'PUBLISHED' AND NEW.status IN ('FILLED', 'CANCELLED', 'EXPIRED')");
    expect(m097).not.toMatch(/OLD\.status = 'FILLED'/);
  });

  it("locks schedule, place and role once published", () => {
    for (const col of ["region_label", "role_label", "starts_at", "ends_at", "visibility"]) {
      expect(m097).toContain(`NEW.${col}`);
    }
    expect(m097).toContain("SMARTMATCH_TERMS_LOCKED_AFTER_PUBLISH");
  });

  it("creates opportunities only as INTERNAL drafts with server-side ids and timestamps", () => {
    expect(m097).toMatch(/smartmatch_opportunities_agency_admin_insert[\s\S]*status = 'DRAFT'[\s\S]*visibility = 'INTERNAL'/);
    expect(m097).toContain("REVOKE INSERT ON smartmatch_opportunities FROM app_runtime");
    const grant = m097.slice(m097.indexOf("GRANT INSERT ("), m097.indexOf("ON smartmatch_opportunities TO app_runtime"));
    expect(grant).not.toMatch(/\bid\b|created_at|updated_at/);
  });

  it("lets any administrator of the agency publish its drafts", () => {
    const publish = service.slice(service.indexOf("export async function activateInternalOpportunity"), service.indexOf("async function requireSmartMatchAgencyAdmin"));
    expect(publish).toContain("await requireSmartMatchAgencyAdmin(trx, userId, organizationId)");
    expect(publish).toContain("AND organization_id = ${organizationId}");
    expect(publish).not.toContain("created_by_user_id = ${userId}");
  });

  it("keeps decision data out of withdrawals", () => {
    expect(m097).toMatch(/smartmatch_applications_worker_withdraw[\s\S]*decision_reason IS NULL[\s\S]*decision_checks IS NULL/);
  });
});

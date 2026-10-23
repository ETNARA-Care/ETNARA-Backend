import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const service = read("src/modules/smartmatch/smartmatch.service.ts");
// Strip SQL line comments so assertions inspect executable statements only.
const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, "");
const m095 = stripSqlComments(read("migrations/095_smartmatch_worker_applications.sql"));

// Static guardrails only. The behavioral proof is scripts/verifySmartMatchRls.ts,
// which runs every attack as app_runtime against the real migration chain.
describe("SmartMatch Gate 1: real caregiver role and network lock", () => {
  it("never authorizes with the non-existent CAREGIVER role code", () => {
    expect(service).not.toMatch(/r\.code\s*=\s*'CAREGIVER'/);
    expect(m095).not.toMatch(/'CAREGIVER'/);
    expect(m095).toContain("r.code = 'WORKER'");
    expect(m095).toContain("owm.status = 'active'");
  });

  it("caregiver discovery uses the same helper as the RLS policy", () => {
    const fn = service.slice(service.indexOf("export async function listCaregiverInternalOpportunities"));
    expect(fn).toContain("app_smartmatch_is_active_worker()");
  });

  it("locks NETWORK visibility with a database CHECK, not only in code", () => {
    expect(m095).toMatch(/ADD CONSTRAINT smartmatch_network_disabled CHECK \(visibility = 'INTERNAL'\)/);
  });

  it("requires recorded consent and grants caregivers no decision columns", () => {
    expect(m095).toContain("smartmatch_application_consent_required");
    expect(m095).toMatch(/GRANT INSERT \(opportunity_id, organization_id, caregiver_user_id, consented_at, consent_version\)/);
    expect(m095).toMatch(/GRANT UPDATE \(status, withdrawn_at\)/);
    expect(m095).not.toMatch(/GRANT[^;]*decided_by_user_id/);
    expect(m095).not.toMatch(/GRANT[^;]*DELETE[^;]*smartmatch/i);
  });

  it("gives the platform/Tower context no SmartMatch policy", () => {
    const smartmatchMigrations = readdirSync(resolve(root, "migrations"))
      .filter(f => /^09\d_smartmatch/.test(f)).map(f => stripSqlComments(read(`migrations/${f}`))).join("\n");
    expect(smartmatchMigrations).not.toContain("app_is_superadmin()");
  });

  it("ships a real-PostgreSQL verifier wired into CI", () => {
    const ci = read(".github/workflows/etnara-ci.yml");
    expect(ci).toContain("scripts/verifySmartMatchRls.ts");
    expect(read("scripts/verifySmartMatchRls.ts")).toContain("SET LOCAL ROLE app_runtime");
  });
});

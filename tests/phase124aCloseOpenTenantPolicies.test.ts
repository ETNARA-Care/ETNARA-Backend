import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/086_close_open_tenant_policies.sql", "utf8");
const verification = readFileSync("src/modules/verification/verification.service.ts", "utf8");
const ci = readFileSync(".github/workflows/etnara-ci.yml", "utf8");

const TABLES = [
  "assignment_history", "assignments", "consent_records", "family_invitations", "organization_memberships",
  "organization_worker_memberships", "professional_scope", "user_roles", "verification_events",
  "verification_overrides", "worker_eligibility", "worker_roles",
];

describe("Phase 12.4a · close the open tenant_isolation policies", () => {
  it("recreates every tenant_isolation policy as RESTRICTIVE", () => {
    const explicit = [...migration.matchAll(/CREATE POLICY (\w+)_tenant_isolation ON \1 AS RESTRICTIVE FOR ALL/g)].map((m) => m[1]);
    const looped = migration.match(/ARRAY\['assignment_history', 'professional_scope', 'worker_roles'\]/) ? ["assignment_history", "professional_scope", "worker_roles"] : [];
    expect(migration).toMatch(/CREATE POLICY %1\$s_tenant_isolation ON %1\$s AS RESTRICTIVE FOR ALL/);
    expect([...explicit, ...looped].sort()).toEqual([...TABLES].sort());
    expect(migration).not.toMatch(/_tenant_isolation ON \w+ FOR ALL/);
  });

  it("does not give every member read access to check-ins", () => {
    expect(migration).not.toMatch(/CREATE POLICY verification_events_member_read/);
  });

  it("keeps self lookups and the legacy invitation token lookup", () => {
    expect(migration).toMatch(/OR user_id = NULLIF\(current_setting\('app.current_user_id', true\), ''\)::uuid/);
    expect(migration).toMatch(/OR invitation_token_hash = NULLIF\(current_setting\('app.lookup_token_hash', true\), ''\)/);
  });

  it("helpers are SECURITY DEFINER with a fixed search_path", () => {
    for (const fn of ["app_is_any_establishment_admin", "app_is_own_worker_membership", "app_shift_has_open_check_in"]) {
      const body = migration.slice(migration.indexOf(`FUNCTION public.${fn}(`));
      expect(body.slice(0, 300)).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(`));
    }
  });

  it("check-out asks the helper whether anyone is still on the shift", () => {
    expect(verification).toMatch(/SELECT app_shift_has_open_check_in\(\$\{shiftId\}\) AS open/);
  });

  it("runs the attack verification in CI", () => {
    expect(ci).toMatch(/scripts\/verifyTenantPolicyClosure\.ts/);
  });
});

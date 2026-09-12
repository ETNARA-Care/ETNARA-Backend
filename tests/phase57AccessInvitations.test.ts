import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 5.7 secure access invitations", () => {
  it("stores only hashed, expiring, single-use invitation tokens", () => {
    const migration = read("migrations/045_secure_access_invitations.sql");
    const service = read("src/modules/accessInvitations/accessInvitations.service.ts");

    expect(migration).toContain("token_hash              text NOT NULL UNIQUE");
    expect(migration).not.toMatch(/raw_token\s+text/i);
    expect(migration).toContain("ai.status = 'pending'");
    expect(migration).toContain("ai.expires_at > now()");
    expect(service).toContain("randomBytes(32)");
    expect(service).toContain("hashToken(rawToken)");
  });

  it("keeps manager operations tenant-scoped and never grants deletion", () => {
    const migration = read("migrations/045_secure_access_invitations.sql");
    const service = read("src/modules/accessInvitations/accessInvitations.service.ts");

    expect(migration).toContain("app_is_org_manager()");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON access_invitations TO app_runtime");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON access_invitations");
    expect(service).toContain("await assertManager(trx)");
    expect(service).not.toMatch(/DELETE FROM access_invitations/);
    expect(service).toContain("deactivateInvitedAccess");
    expect(service).toContain("SET status = 'revoked', revoked_at = now()");
  });

  it("hides deactivated Worker and Family roles from the login context", () => {
    const context = read("src/modules/organizationContext/organizationContext.service.ts");
    const migration = read("migrations/045_secure_access_invitations.sql");
    expect(context).toContain("r.code NOT IN ('WORKER', 'FAMILY')");
    expect(context).toContain("app_self_has_active_worker_access");
    expect(context).toContain("app_self_has_active_family_access");
    expect(migration).toContain("owm.status = 'active'");
    expect(migration).toContain("fr.status = 'active'");
    expect(migration).toContain("p_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid");
  });

  it("activates the exact worker or Family relationship atomically", () => {
    const migration = read("migrations/045_secure_access_invitations.sql");

    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("INVITATION_IDENTITY_MISMATCH");
    expect(migration).toContain("SET user_id = v_user_id");
    expect(migration).toContain("INSERT INTO public.family_relationships");
    expect(migration).toContain("SET status = 'accepted', accepted_at = now()");
    expect(migration).toContain("SECURITY DEFINER SET search_path = pg_catalog, public");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app_activate_access_invitation");
  });

  it("never resets the password of an existing account", () => {
    const migration = read("migrations/045_secure_access_invitations.sql");
    expect(migration).not.toMatch(/UPDATE public\.users[\s\S]{0,180}password_hash/i);
    expect(migration).toContain("ACCOUNT_ALREADY_EXISTS");
  });

  it("qualifies worker account columns that collide with function output names", () => {
    const hotfix = read("migrations/046_access_invitation_activation_ambiguity_fix.sql");
    const verification = read("scripts/verifyAccessInvitationActivation.ts");

    expect(hotfix).toContain("UPDATE public.workers AS target_worker");
    expect(hotfix).toContain("target_worker.user_id IS NULL");
    expect(hotfix).toContain("ON CONFLICT ON CONSTRAINT organization_memberships_user_id_organization_id_key");
    expect(verification).toContain("app_activate_access_invitation");
    expect(verification).toContain("Activation did not link the worker to the new account");
  });
});

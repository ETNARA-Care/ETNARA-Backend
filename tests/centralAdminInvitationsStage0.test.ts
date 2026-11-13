import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { centralEmailDelivery } from "../src/modules/platformOrganizations/platformAdminInvitations.delivery.js";
import { checkCentralResendLimit, resetCentralResendLimit, CENTRAL_RESEND_LIMIT_PER_USER } from "../src/modules/platformOrganizations/platformAdminInvitations.rateLimit.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Etapa 0: Central never receives the agency administrator's activation link", () => {
  const routes = read("src/modules/platformOrganizations/platformOrganizations.routes.ts");
  const service = read("src/modules/platformOrganizations/platformOrganizations.service.ts");
  const invitations = read("src/modules/platformOrganizations/platformAdminInvitations.service.ts");

  it("no Central response carries the token or its hash", () => {
    expect(routes).not.toMatch(/activationToken\s*:/);
    expect(routes).not.toContain("rawToken");
    expect(service).not.toMatch(/return\{invitation,rawToken/);
    expect(service).toMatch(/return\{invitation,emailDelivery\}/);
    // The resend and revoke services build responses from explicit columns only.
    expect(invitations).not.toMatch(/RETURNING[^`]*token_hash/);
    expect(invitations).not.toMatch(/SELECT[^`]*token_hash[^`]*FROM access_invitations/);
    expect(invitations).not.toMatch(/return \{[^}]*rawToken/);
  });

  it("audits create, resend, failed resend and revoke without secrets or the invitee's address", () => {
    for (const action of ["ORG_ADMIN_INVITATION_CREATED", "ORG_ADMIN_INVITATION_RESENT", "ORG_ADMIN_INVITATION_RESEND_FAILED", "ORG_ADMIN_INVITATION_REVOKED"]) {
      expect(invitations + service).toContain(action);
    }
    const auditCalls = (invitations + service).match(/recordInvitationAudit\([^;]*\)/g) ?? [];
    expect(auditCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of auditCalls) expect(c).not.toMatch(/rawToken|tokenHash|token_hash|\bemail\b|recipientEmail|\.email\b/);
  });

  it("reduces provider results to fixed codes (no provider message or id)", () => {
    expect(centralEmailDelivery({ status: "sent", messageId: "msg_1" })).toEqual({ status: "sent" });
    expect(centralEmailDelivery({ status: "failed", error: "EMAIL_NOT_CONFIGURED" })).toEqual({ status: "failed", error: "EMAIL_NOT_CONFIGURED" });
    expect(centralEmailDelivery({ status: "failed", error: "getaddrinfo ENOTFOUND internal.host" })).toEqual({ status: "failed", error: "EMAIL_SEND_FAILED" });
    expect(centralEmailDelivery({ status: "failed", error: "HTTP 500" })).toEqual({ status: "failed", error: "EMAIL_SEND_FAILED" });
  });

  it("limits resends per Central user", () => {
    resetCentralResendLimit();
    let ok = 0;
    for (let i = 0; i < CENTRAL_RESEND_LIMIT_PER_USER + 5; i++) if (checkCentralResendLimit("user-a")) ok++;
    expect(ok).toBe(CENTRAL_RESEND_LIMIT_PER_USER);
    expect(checkCentralResendLimit("user-b")).toBe(true);
    expect(checkCentralResendLimit("user-a", Date.now() + 61 * 60 * 1000)).toBe(true);
    resetCentralResendLimit();
  });

  it("only touches invitations Central created, never the agency's own team invitations", () => {
    expect(invitations).toContain("ORG_ADMIN_INVITATION_CREATED");
    expect(invitations).toMatch(/NOT EXISTS \(SELECT 1 FROM organization_memberships om WHERE om\.user_id = ai\.invited_by_user_id/);
    const team = read("src/modules/team/team.service.ts");
    expect(team).not.toContain("ORG_ADMIN_INVITATION_CREATED");
  });
});

import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { hashToken } from "../../security/sessionToken.js";
import { loadEmailConfig, sendOrganizationAdminInvitationEmail } from "../email/email.service.js";

/**
 * Phase 12.2: an agency administrator invites administrators and supervisors.
 * Reuses access_invitations type 'organization_admin' + staff_role (085) and
 * the existing activation page and SECURITY DEFINER activation function.
 * Only ORGANIZATION_ADMIN may use any of this; RLS enforces the same rule.
 */
export class TeamForbiddenError extends Error {
  constructor() {
    super("TEAM_FORBIDDEN");
    this.name = "TeamForbiddenError";
  }
}

export class TeamInvitationError extends Error {
  constructor(public readonly code: "ALREADY_A_MEMBER" | "INVITATION_NOT_FOUND") {
    super(code);
    this.name = "TeamInvitationError";
  }
}

export const staffRoleSchema = z.enum(["ORGANIZATION_ADMIN", "SUPERVISOR"]);
export const inviteTeamMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: staffRoleSchema,
}).strict();
export type InviteTeamMemberInput = z.infer<typeof inviteTeamMemberSchema>;

async function assertOrgAdmin(trx: unknown) {
  const result = await sql<{ ok: boolean }>`SELECT app_is_org_admin() AS ok`.execute(trx as never);
  if (!result.rows[0]?.ok) throw new TeamForbiddenError();
}

export interface TeamMember {
  membershipId: string;
  email: string;
  roles: Array<"ORGANIZATION_ADMIN" | "SUPERVISOR">;
  isYou: boolean;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: "ORGANIZATION_ADMIN" | "SUPERVISOR";
  expiresAt: string;
  createdAt: string;
}

export async function listTeam(userId: string, organizationId: string): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgAdmin(trx);
    const members = await sql<{ membership_id: string; email: string; user_id: string; roles: string[] }>`
      SELECT om.id AS membership_id, u.email, u.id AS user_id,
             array_agg(DISTINCT r.code ORDER BY r.code) AS roles
      FROM organization_memberships om
      JOIN users u ON u.id = om.user_id
      JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
      JOIN roles r ON r.id = ur.role_id
      WHERE om.organization_id = ${organizationId}
        AND om.status = 'active'
        AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
      GROUP BY om.id, u.email, u.id
      ORDER BY u.email
    `.execute(trx);
    const invitations = await sql<{ id: string; email: string; staff_role: "ORGANIZATION_ADMIN" | "SUPERVISOR"; expires_at: string; created_at: string }>`
      SELECT id, email, staff_role, expires_at, created_at
      FROM access_invitations
      WHERE organization_id = ${organizationId}
        AND invitation_type = 'organization_admin'
        AND status = 'pending'
        AND expires_at > now()
      ORDER BY created_at DESC
    `.execute(trx);
    return {
      members: members.rows.map((row) => ({
        membershipId: row.membership_id,
        email: row.email,
        roles: row.roles.filter((code): code is "ORGANIZATION_ADMIN" | "SUPERVISOR" => code === "ORGANIZATION_ADMIN" || code === "SUPERVISOR"),
        isYou: row.user_id === userId,
      })),
      invitations: invitations.rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.staff_role,
        expiresAt: new Date(row.expires_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  });
}

export async function inviteTeamMember(userId: string, organizationId: string, input: InviteTeamMemberInput) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgAdmin(trx);
    const existing = await sql<{ id: string }>`
      SELECT om.id FROM organization_memberships om JOIN users u ON u.id = om.user_id
      WHERE om.organization_id = ${organizationId} AND lower(u.email) = ${input.email} AND om.status = 'active'
      LIMIT 1
    `.execute(trx);
    if (existing.rows[0]) throw new TeamInvitationError("ALREADY_A_MEMBER");

    // One live invitation per email: a new one replaces the previous one.
    await sql`
      UPDATE access_invitations
      SET status = CASE WHEN expires_at <= now() THEN 'expired'::access_invitation_status_enum ELSE 'revoked'::access_invitation_status_enum END,
          revoked_at = CASE WHEN expires_at > now() THEN now() ELSE revoked_at END,
          updated_at = now()
      WHERE organization_id = ${organizationId} AND invitation_type = 'organization_admin'
        AND lower(email) = ${input.email} AND status = 'pending'
    `.execute(trx);

    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const inserted = await sql<{ id: string; email: string; staff_role: "ORGANIZATION_ADMIN" | "SUPERVISOR"; expires_at: string; created_at: string }>`
      INSERT INTO access_invitations (organization_id, invited_by_user_id, invitation_type, staff_role, email, token_hash, expires_at)
      VALUES (${organizationId}, ${userId}, 'organization_admin', ${input.role}, ${input.email}, ${hashToken(rawToken)}, ${expiresAt})
      RETURNING id, email, staff_role, expires_at, created_at
    `.execute(trx);
    const meta = await sql<{ organization_name: string; inviter_email: string | null }>`
      SELECT o.name AS organization_name, (SELECT email FROM users WHERE id = ${userId}) AS inviter_email
      FROM organizations o WHERE o.id = ${organizationId}
    `.execute(trx);
    const emailDelivery = await sendOrganizationAdminInvitationEmail({
      recipientEmail: input.email,
      organizationName: meta.rows[0]?.organization_name ?? "ETNARA Care",
      activationToken: rawToken,
      invitedByEmail: meta.rows[0]?.inviter_email ?? "admin@etnara.care",
      staffRole: input.role,
    }, loadEmailConfig());
    const row = inserted.rows[0];
    return {
      invitation: { id: row.id, email: row.email, role: row.staff_role, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString() } satisfies TeamInvitation,
      token: rawToken,
      emailDelivery,
    };
  });
}

export async function revokeTeamInvitation(userId: string, organizationId: string, invitationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgAdmin(trx);
    const result = await sql<{ id: string }>`
      UPDATE access_invitations SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = ${invitationId}::uuid AND organization_id = ${organizationId}
        AND invitation_type = 'organization_admin' AND status = 'pending'
      RETURNING id
    `.execute(trx);
    if (!result.rows[0]) throw new TeamInvitationError("INVITATION_NOT_FOUND");
    return { id: result.rows[0].id };
  });
}

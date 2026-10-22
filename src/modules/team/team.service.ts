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
  constructor(public readonly code: "ALREADY_A_MEMBER" | "INVITATION_NOT_FOUND" | "MEMBER_NOT_FOUND" | "NO_ACCOUNT_YET" | "CANNOT_REMOVE_OWN_ADMIN" | "LAST_ADMIN") {
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
  /** Set when this person also works shifts as a caregiver here. */
  workerMembershipId: string | null;
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
    const members = await sql<{ membership_id: string; email: string; user_id: string; roles: string[]; worker_membership_id: string | null }>`
      SELECT om.id AS membership_id, u.email, u.id AS user_id,
             array_agg(DISTINCT r.code ORDER BY r.code) AS roles,
             (SELECT owm.id FROM workers w JOIN organization_worker_memberships owm ON owm.worker_id = w.id
               WHERE w.user_id = u.id AND owm.organization_id = om.organization_id AND owm.status = 'active' LIMIT 1) AS worker_membership_id
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
        workerMembershipId: row.worker_membership_id,
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

/**
 * Phase 12.3: give or remove a staff role to someone already in this agency
 * (e.g. a caregiver who also becomes a supervisor and keeps working shifts).
 * Identify the person by organization membership or by caregiver membership.
 */
export const setStaffRoleSchema = z.object({
  membershipId: z.string().uuid().optional(),
  workerMembershipId: z.string().uuid().optional(),
  role: staffRoleSchema,
  enabled: z.boolean(),
}).strict().refine((value) => Boolean(value.membershipId) !== Boolean(value.workerMembershipId), {
  message: "Exactly one of membershipId or workerMembershipId",
});
export type SetStaffRoleInput = z.infer<typeof setStaffRoleSchema>;

export async function setStaffRole(userId: string, organizationId: string, input: SetStaffRoleInput) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertOrgAdmin(trx);
    // Serialize role changes per agency so two admins cannot remove each other at once.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${"team-roles:" + organizationId}))`.execute(trx);
    const target = input.membershipId
      ? await sql<{ membership_id: string; user_id: string }>`
          SELECT om.id AS membership_id, om.user_id FROM organization_memberships om
          WHERE om.id = ${input.membershipId}::uuid AND om.organization_id = ${organizationId} AND om.status = 'active'
        `.execute(trx)
      : await sql<{ membership_id: string | null; user_id: string | null }>`
          SELECT om.id AS membership_id, w.user_id FROM organization_worker_memberships owm
          JOIN workers w ON w.id = owm.worker_id
          LEFT JOIN organization_memberships om ON om.user_id = w.user_id AND om.organization_id = owm.organization_id AND om.status = 'active'
          WHERE owm.id = ${input.workerMembershipId!}::uuid AND owm.organization_id = ${organizationId} AND owm.status = 'active'
        `.execute(trx);
    const row = target.rows[0];
    if (!row) throw new TeamInvitationError("MEMBER_NOT_FOUND");
    if (!row.membership_id || !row.user_id) throw new TeamInvitationError("NO_ACCOUNT_YET");

    const role = await sql<{ id: string }>`SELECT id FROM roles WHERE code = ${input.role} LIMIT 1`.execute(trx);
    if (!role.rows[0]) throw new Error("ROLE_NOT_CONFIGURED");

    if (input.enabled) {
      await sql`
        INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
        VALUES (${row.membership_id}::uuid, ${organizationId}, ${role.rows[0].id})
        ON CONFLICT ON CONSTRAINT user_roles_organization_membership_id_role_id_key DO NOTHING
      `.execute(trx);
    } else {
      if (input.role === "ORGANIZATION_ADMIN") {
        if (row.user_id === userId) throw new TeamInvitationError("CANNOT_REMOVE_OWN_ADMIN");
        const admins = await sql<{ count: string }>`
          SELECT count(DISTINCT om.id)::text AS count FROM organization_memberships om
          JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
          JOIN roles r ON r.id = ur.role_id
          WHERE om.organization_id = ${organizationId} AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
        `.execute(trx);
        if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new TeamInvitationError("LAST_ADMIN");
      }
      await sql`
        DELETE FROM user_roles
        WHERE organization_membership_id = ${row.membership_id}::uuid AND organization_id = ${organizationId} AND role_id = ${role.rows[0].id}
      `.execute(trx);
    }
    return { membershipId: row.membership_id, role: input.role, enabled: input.enabled };
  });
}

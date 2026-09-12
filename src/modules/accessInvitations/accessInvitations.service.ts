import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { hashPassword } from "../../security/password.js";
import { hashToken } from "../../security/sessionToken.js";

const INVITATION_TTL_DAYS = 7;

export class AccessInvitationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AccessInvitationError";
  }
}

export class AccessInvitationForbiddenError extends Error {
  constructor() {
    super("ACCESS_INVITATION_FORBIDDEN");
    this.name = "AccessInvitationForbiddenError";
  }
}

export const createAccessInvitationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("worker"),
    email: z.string().trim().email().max(254),
    workerMembershipId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("family"),
    email: z.string().trim().email().max(254),
    careRecipientId: z.string().uuid(),
    relationshipType: z.string().trim().min(1).max(80),
  }),
]);
export type CreateAccessInvitationInput = z.infer<typeof createAccessInvitationSchema>;

export const activateAccessInvitationSchema = z.object({
  token: z.string().length(64),
  password: z.string().min(12).max(128),
});

interface InvitationRow {
  id: string;
  organization_id: string;
  invitation_type: "worker" | "family";
  email: string;
  worker_membership_id: string | null;
  care_recipient_id: string | null;
  relationship_type: string | null;
  status: "pending" | "accepted" | "expired" | "revoked";
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  target_name: string;
  account_linked: boolean;
}

async function assertManager(trx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) {
  const result = await sql<{ allowed: boolean }>`SELECT app_is_org_manager() AS allowed`.execute(trx);
  if (!result.rows[0]?.allowed) throw new AccessInvitationForbiddenError();
}

function invitationToken() {
  const rawToken = randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashToken(rawToken) };
}

function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const known = [
    "INVITATION_NOT_AVAILABLE",
    "INVITATION_EXPIRED",
    "ACCOUNT_ALREADY_EXISTS",
    "INVITATION_IDENTITY_MISMATCH",
    "ACCOUNT_DISABLED",
    "INVALID_ACTIVATION",
    "ROLE_NOT_CONFIGURED",
    "WORKER_NOT_ACTIVE",
    "WORKER_ALREADY_LINKED",
  ].find((code) => message.includes(code));
  if (known) throw new AccessInvitationError(known);
  throw error;
}

export async function createAccessInvitation(
  userId: string,
  organizationId: string,
  input: CreateAccessInvitationInput
): Promise<{ invitation: InvitationRow; rawToken: string }> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const email = input.email.toLowerCase();

    await sql`
      UPDATE access_invitations
      SET status = 'expired', updated_at = now()
      WHERE organization_id = ${organizationId}
        AND status = 'pending'
        AND expires_at <= now()
    `.execute(trx);

    let targetName: string;
    if (input.type === "worker") {
      const target = await sql<{ target_name: string; status: string; user_id: string | null }>`
        SELECT coalesce(w.display_name, 'Personal de cuidado') AS target_name, owm.status, w.user_id
        FROM organization_worker_memberships owm
        JOIN workers w ON w.id = owm.worker_id
        WHERE owm.id = ${input.workerMembershipId}
          AND owm.organization_id = ${organizationId}
        LIMIT 1
      `.execute(trx);
      if (!target.rows[0]) throw new AccessInvitationError("TARGET_NOT_FOUND");
      if (target.rows[0].status !== "active") throw new AccessInvitationError("WORKER_NOT_ACTIVE");
      if (target.rows[0].user_id) throw new AccessInvitationError("WORKER_ALREADY_LINKED");
      targetName = target.rows[0].target_name;
    } else {
      const target = await sql<{ target_name: string; status: string }>`
        SELECT coalesce(preferred_name, first_name || ' ' || last_name) AS target_name, status
        FROM care_recipients
        WHERE id = ${input.careRecipientId} AND organization_id = ${organizationId}
        LIMIT 1
      `.execute(trx);
      if (!target.rows[0]) throw new AccessInvitationError("TARGET_NOT_FOUND");
      if (target.rows[0].status !== "active") throw new AccessInvitationError("RECIPIENT_NOT_ACTIVE");
      targetName = target.rows[0].target_name;
    }

    const pending = await sql<{ id: string }>`
      SELECT id FROM access_invitations
      WHERE organization_id = ${organizationId}
        AND lower(email) = ${email}
        AND status = 'pending'
        AND (
          (${input.type === "worker"} AND worker_membership_id = ${input.type === "worker" ? input.workerMembershipId : null})
          OR
          (${input.type === "family"} AND care_recipient_id = ${input.type === "family" ? input.careRecipientId : null})
        )
      LIMIT 1
    `.execute(trx);
    if (pending.rows[0]) throw new AccessInvitationError("INVITATION_ALREADY_PENDING");

    const { rawToken, tokenHash } = invitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString();
    const result = await sql<Omit<InvitationRow, "target_name" | "account_linked">>`
      INSERT INTO access_invitations (
        organization_id, invited_by_user_id, invitation_type, email,
        worker_membership_id, care_recipient_id, relationship_type,
        token_hash, expires_at
      ) VALUES (
        ${organizationId}, ${userId}, ${input.type}, ${email},
        ${input.type === "worker" ? input.workerMembershipId : null},
        ${input.type === "family" ? input.careRecipientId : null},
        ${input.type === "family" ? input.relationshipType : null},
        ${tokenHash}, ${expiresAt}
      )
      RETURNING id, organization_id, invitation_type, email, worker_membership_id,
                care_recipient_id, relationship_type, status, expires_at,
                accepted_at, revoked_at, created_at, updated_at
    `.execute(trx);
    return {
      invitation: { ...result.rows[0], target_name: targetName, account_linked: false },
      rawToken,
    };
  });
}

export async function listAccessInvitations(
  userId: string,
  organizationId: string,
  target: { workerMembershipId?: string; careRecipientId?: string }
): Promise<InvitationRow[]> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<InvitationRow>`
      SELECT ai.id, ai.organization_id, ai.invitation_type, ai.email,
             ai.worker_membership_id, ai.care_recipient_id, ai.relationship_type,
             CASE WHEN ai.status = 'pending' AND ai.expires_at <= now()
                  THEN 'expired' ELSE ai.status::text END AS status,
             ai.expires_at, ai.accepted_at, ai.revoked_at, ai.created_at, ai.updated_at,
             CASE WHEN ai.invitation_type = 'worker'
                  THEN coalesce(w.display_name, 'Personal de cuidado')
                  ELSE coalesce(cr.preferred_name, cr.first_name || ' ' || cr.last_name)
             END AS target_name,
             CASE WHEN ai.invitation_type = 'worker'
                  THEN w.user_id IS NOT NULL AND owm.status = 'active'
                  ELSE EXISTS (
                    SELECT 1 FROM users u
                    JOIN family_relationships fr ON fr.user_id = u.id
                    WHERE lower(u.email) = lower(ai.email)
                      AND fr.care_recipient_id = ai.care_recipient_id
                      AND fr.status = 'active'
                  )
             END AS account_linked
      FROM access_invitations ai
      LEFT JOIN organization_worker_memberships owm ON owm.id = ai.worker_membership_id
      LEFT JOIN workers w ON w.id = owm.worker_id
      LEFT JOIN care_recipients cr ON cr.id = ai.care_recipient_id
      WHERE ai.organization_id = ${organizationId}
        AND (${target.workerMembershipId ?? null}::uuid IS NULL OR ai.worker_membership_id = ${target.workerMembershipId ?? null})
        AND (${target.careRecipientId ?? null}::uuid IS NULL OR ai.care_recipient_id = ${target.careRecipientId ?? null})
      ORDER BY ai.created_at DESC
    `.execute(trx);
    return result.rows;
  });
}

export async function revokeAccessInvitation(userId: string, organizationId: string, invitationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const result = await sql<{ id: string }>`
      UPDATE access_invitations
      SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = ${invitationId} AND organization_id = ${organizationId}
        AND status IN ('pending', 'expired')
      RETURNING id
    `.execute(trx);
    if (!result.rows[0]) throw new AccessInvitationError("INVITATION_NOT_REVOCABLE");
  });
}

export async function deactivateInvitedAccess(userId: string, organizationId: string, invitationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const invitation = await sql<{
      invitation_type: "worker" | "family";
      email: string;
      worker_membership_id: string | null;
      care_recipient_id: string | null;
    }>`
      SELECT invitation_type, email, worker_membership_id, care_recipient_id
      FROM access_invitations
      WHERE id = ${invitationId} AND organization_id = ${organizationId}
        AND status = 'accepted'
      LIMIT 1
    `.execute(trx);
    const row = invitation.rows[0];
    if (!row) throw new AccessInvitationError("ACCEPTED_INVITATION_NOT_FOUND");

    if (row.invitation_type === "worker") {
      const result = await sql<{ id: string }>`
        UPDATE organization_worker_memberships
        SET status = 'inactive', ended_at = now(), updated_at = now()
        WHERE id = ${row.worker_membership_id} AND organization_id = ${organizationId}
          AND status = 'active'
        RETURNING id
      `.execute(trx);
      if (!result.rows[0]) throw new AccessInvitationError("ACCESS_ALREADY_INACTIVE");
    } else {
      const result = await sql<{ id: string }>`
        UPDATE family_relationships fr
        SET status = 'revoked', revoked_at = now()
        FROM users u
        WHERE fr.user_id = u.id
          AND lower(u.email) = lower(${row.email})
          AND fr.care_recipient_id = ${row.care_recipient_id}
          AND fr.organization_id = ${organizationId}
          AND fr.status = 'active'
        RETURNING fr.id
      `.execute(trx);
      if (!result.rows[0]) throw new AccessInvitationError("ACCESS_ALREADY_INACTIVE");
    }
  });
}

export async function renewAccessInvitation(
  userId: string,
  organizationId: string,
  invitationId: string
): Promise<{ invitation: InvitationRow; rawToken: string }> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertManager(trx);
    const { rawToken, tokenHash } = invitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString();
    const result = await sql<Omit<InvitationRow, "target_name" | "account_linked">>`
      UPDATE access_invitations
      SET token_hash = ${tokenHash}, status = 'pending', expires_at = ${expiresAt},
          accepted_at = NULL, revoked_at = NULL, updated_at = now()
      WHERE id = ${invitationId} AND organization_id = ${organizationId}
        AND status IN ('pending', 'expired')
      RETURNING id, organization_id, invitation_type, email,
                worker_membership_id, care_recipient_id, relationship_type,
                status, expires_at, accepted_at, revoked_at, created_at, updated_at
    `.execute(trx);
    if (!result.rows[0]) throw new AccessInvitationError("INVITATION_NOT_RENEWABLE");
    const row = result.rows[0];
    const target = row.invitation_type === "worker"
      ? await sql<{ target_name: string }>`
          SELECT coalesce(w.display_name, 'Personal de cuidado') AS target_name
          FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
          WHERE owm.id = ${row.worker_membership_id} LIMIT 1
        `.execute(trx)
      : await sql<{ target_name: string }>`
          SELECT coalesce(preferred_name, first_name || ' ' || last_name) AS target_name
          FROM care_recipients WHERE id = ${row.care_recipient_id} LIMIT 1
        `.execute(trx);
    return {
      invitation: { ...row, target_name: target.rows[0]?.target_name ?? "Invitación", account_linked: false },
      rawToken,
    };
  });
}

export async function inspectAccessInvitation(rawToken: string) {
  try {
    const result = await sql<{
      invitation_type: "worker" | "family";
      email_masked: string;
      organization_name: string;
      target_name: string;
      account_exists: boolean;
      expires_at: string;
    }>`SELECT * FROM app_inspect_access_invitation(${hashToken(rawToken)})`.execute(db);
    return result.rows[0];
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function activateAccessInvitation(rawToken: string, password: string) {
  const inspection = await inspectAccessInvitation(rawToken);
  if (inspection.account_exists) throw new AccessInvitationError("ACCOUNT_ALREADY_EXISTS");
  const passwordHash = await hashPassword(password);
  try {
    const result = await sql<{ user_id: string; organization_id: string; invitation_type: string }>`
      SELECT * FROM app_activate_access_invitation(${hashToken(rawToken)}, ${passwordHash}, NULL)
    `.execute(db);
    return result.rows[0];
  } catch (error) {
    return translateDatabaseError(error);
  }
}

export async function acceptAccessInvitation(userId: string, rawToken: string) {
  try {
    const result = await sql<{ user_id: string; organization_id: string; invitation_type: string }>`
      SELECT * FROM app_activate_access_invitation(${hashToken(rawToken)}, NULL, ${userId})
    `.execute(db);
    return result.rows[0];
  } catch (error) {
    return translateDatabaseError(error);
  }
}

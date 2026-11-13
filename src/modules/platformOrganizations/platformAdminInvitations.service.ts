import { randomBytes } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Database } from "../../config/db.js";
import { withPlatformContext } from "../../context/tenantContext.js";
import { hashToken } from "../../security/sessionToken.js";
import { loadEmailConfig, sendOrganizationAdminInvitationEmail } from "../email/email.service.js";
import { centralEmailDelivery, type CentralEmailDelivery } from "./platformAdminInvitations.delivery.js";

/**
 * Etapa 0 (9-nov-2026): ETNARA Central invita al administrador de una agencia, pero NUNCA conoce el
 * enlace secreto de activación. El token viaja solo en el correo al invitado; ninguna respuesta de Central
 * contiene el token ni su hash. Si el correo falla, Central reenvía (token nuevo: el anterior deja de valer)
 * o revoca e invita a la dirección corregida. No existe vía de emergencia que muestre el enlace.
 *
 * Alcance: solo invitaciones de administrador creadas por ETNARA Central (invited_by es un administrador de
 * la plataforma y staff_role = ORGANIZATION_ADMIN). Las invitaciones de equipo que crea la propia agencia
 * siguen siendo de la agencia (team.service.ts) y Central no las lista, reenvía ni revoca.
 *
 * Auditoría: audit_log (solo INSERT para app_runtime desde 017), con organization_id = target_organization_id =
 * agencia, como el resto de registros de audit_log (la sonda entre agencias lo exige). Los miembros de la agencia
 * pueden leer que Central creó, reenvió o revocó una invitación; nunca la dirección ni ningún secreto.
 * Nunca se guarda el token, su hash, el correo del invitado ni mensajes del proveedor de correo.
 */

export const INVITATION_TTL_MS = 7 * 86_400_000;
/** Reenvíos (con éxito o fallidos) por invitación en una hora. */
export const RESEND_LIMIT_PER_HOUR = 5;

export { centralEmailDelivery, type CentralEmailDelivery };

export class PlatformAdminInvitationError extends Error {
  constructor(public readonly code: "INVITATION_NOT_FOUND" | "INVITATION_NOT_RESENDABLE" | "INVITATION_NOT_REVOCABLE" | "ORGANIZATION_NOT_FOUND" | "RESEND_LIMIT_REACHED") {
    super(code);
    this.name = "PlatformAdminInvitationError";
  }
}

export const invitationIdSchema = z.string().uuid();

export interface CentralAdminInvitation {
  id: string;
  email: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  /** Still pending in the database (also past its expiry: resending renews it). */
  resendable: boolean;
  revocable: boolean;
}

type Trx = Transaction<Database>;
type Row = { id: string; email: string; status: string; created_at: Date | string; expires_at: Date | string; accepted_at: Date | string | null; revoked_at: Date | string | null };
const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
function toInvitation(r: Row): CentralAdminInvitation {
  // A pending row past its expiry is shown as expired (activation would refuse it).
  const status = r.status === "pending" && new Date(r.expires_at).getTime() <= Date.now() ? "expired" : r.status;
  return { id: r.id, email: r.email, status: status as CentralAdminInvitation["status"], createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at)!, acceptedAt: iso(r.accepted_at), revokedAt: iso(r.revoked_at), resendable: r.status === "pending", revocable: r.status === "pending" };
}

/**
 * Only invitations ETNARA Central itself created for an agency administrator:
 *  - from Etapa 0 on, every Central invitation has an ORG_ADMIN_INVITATION_CREATED audit row (team invitations
 *    created by the agency never do);
 *  - earlier Central invitations: the inviter is a platform administrator WITHOUT an active membership in that
 *    agency (a person who is both platform admin and agency admin invites through the agency's team page, and
 *    those invitations stay the agency's).
 */
const CENTRAL_SCOPE = sql`ai.invitation_type = 'organization_admin' AND ai.staff_role = 'ORGANIZATION_ADMIN'
  AND (EXISTS (SELECT 1 FROM audit_log al WHERE al.entity_type = 'access_invitation' AND al.entity_id = ai.id AND al.action = 'ORG_ADMIN_INVITATION_CREATED')
       OR (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = ai.invited_by_user_id)
           AND NOT EXISTS (SELECT 1 FROM organization_memberships om WHERE om.user_id = ai.invited_by_user_id AND om.organization_id = ai.organization_id AND om.status = 'active')))`;

export async function recordInvitationAudit(trx: Trx, actorUserId: string, organizationId: string, invitationId: string, action: string, details: Record<string, string | number | boolean | null>) {
  await sql`INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
            VALUES (${actorUserId}, ${organizationId}, ${organizationId}, ${action}, 'access_invitation', ${invitationId}, ${JSON.stringify(details)}::jsonb)`.execute(trx);
}

async function requireOrganization(trx: Trx, organizationId: string, active: boolean) {
  const org = await sql<{ id: string; name: string }>`SELECT id, name FROM organizations WHERE id = ${organizationId}
    ${active ? sql`AND status IN ('active','trial') AND archived_at IS NULL` : sql``} LIMIT 1`.execute(trx);
  if (!org.rows[0]) throw new PlatformAdminInvitationError("ORGANIZATION_NOT_FOUND");
  return org.rows[0];
}

export async function listCentralAdminInvitations(userId: string, organizationId: string): Promise<CentralAdminInvitation[]> {
  if (!invitationIdSchema.safeParse(organizationId).success) throw new PlatformAdminInvitationError("ORGANIZATION_NOT_FOUND");
  return withPlatformContext(userId, async (trx) => {
    await requireOrganization(trx, organizationId, false);
    const rows = await sql<Row>`SELECT ai.id, ai.email, ai.status::text AS status, ai.created_at, ai.expires_at, ai.accepted_at, ai.revoked_at
      FROM access_invitations ai WHERE ai.organization_id = ${organizationId} AND ${CENTRAL_SCOPE}
      ORDER BY ai.created_at DESC LIMIT 50`.execute(trx);
    return rows.rows.map(toInvitation);
  });
}

class RollbackForFailedDelivery extends Error {
  constructor(public readonly delivery: CentralEmailDelivery) { super("ROLLBACK_FAILED_DELIVERY"); }
}

/**
 * Rotates the token and emails the new link. The previous link stops working only when the new email is
 * accepted by the provider: if delivery fails the rotation is rolled back (the recipient may still hold the
 * previous, valid link) and only the failed attempt is audited. Pending invitations past their expiry are
 * renewed for 7 days; accepted, revoked or expired-status invitations are not resendable.
 */
export async function resendCentralAdminInvitation(userId: string, organizationId: string, invitationId: string): Promise<{ invitation: CentralAdminInvitation; emailDelivery: CentralEmailDelivery }> {
  if (!invitationIdSchema.safeParse(organizationId).success || !invitationIdSchema.safeParse(invitationId).success) throw new PlatformAdminInvitationError("INVITATION_NOT_FOUND");
  try {
    return await withPlatformContext(userId, async (trx) => {
      const org = await requireOrganization(trx, organizationId, true);
      const current = (await sql<Row>`SELECT ai.id, ai.email, ai.status::text AS status, ai.created_at, ai.expires_at, ai.accepted_at, ai.revoked_at
        FROM access_invitations ai WHERE ai.id = ${invitationId} AND ai.organization_id = ${organizationId} AND ${CENTRAL_SCOPE}
        FOR UPDATE OF ai`.execute(trx)).rows[0];
      if (!current) throw new PlatformAdminInvitationError("INVITATION_NOT_FOUND");
      if (current.status !== "pending") throw new PlatformAdminInvitationError("INVITATION_NOT_RESENDABLE");
      // The row lock serializes concurrent resends of this invitation, so the count is exact.
      const attempts = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log
        WHERE entity_type = 'access_invitation' AND entity_id = ${invitationId}
          AND action IN ('ORG_ADMIN_INVITATION_RESENT','ORG_ADMIN_INVITATION_RESEND_FAILED')
          AND occurred_at > now() - interval '1 hour'`.execute(trx)).rows[0]?.n ?? 0;
      if (attempts >= RESEND_LIMIT_PER_HOUR) throw new PlatformAdminInvitationError("RESEND_LIMIT_REACHED");

      const rawToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const updated = (await sql<Row>`UPDATE access_invitations AS ai SET token_hash = ${hashToken(rawToken)}, expires_at = ${expiresAt}, updated_at = now()
        WHERE ai.id = ${invitationId} AND ai.status = 'pending'
        RETURNING ai.id, ai.email, ai.status::text AS status, ai.created_at, ai.expires_at, ai.accepted_at, ai.revoked_at`.execute(trx)).rows[0];
      if (!updated) throw new PlatformAdminInvitationError("INVITATION_NOT_RESENDABLE");
      const inviter = (await sql<{ email: string | null }>`SELECT email FROM users WHERE id = ${userId} LIMIT 1`.execute(trx)).rows[0];
      const delivery = centralEmailDelivery(await sendOrganizationAdminInvitationEmail(
        { recipientEmail: updated.email, organizationName: org.name, activationToken: rawToken, invitedByEmail: inviter?.email || "admin@etnara.care" },
        loadEmailConfig()));
      if (delivery.status === "failed") throw new RollbackForFailedDelivery(delivery);
      await recordInvitationAudit(trx, userId, organizationId, invitationId, "ORG_ADMIN_INVITATION_RESENT", { emailDelivery: "sent", expiresAt });
      return { invitation: toInvitation(updated), emailDelivery: delivery };
    });
  } catch (error) {
    if (!(error instanceof RollbackForFailedDelivery)) throw error;
    return withPlatformContext(userId, async (trx) => {
      await recordInvitationAudit(trx, userId, organizationId, invitationId, "ORG_ADMIN_INVITATION_RESEND_FAILED", { emailDelivery: "failed", error: error.delivery.error ?? "EMAIL_SEND_FAILED" });
      const row = (await sql<Row>`SELECT ai.id, ai.email, ai.status::text AS status, ai.created_at, ai.expires_at, ai.accepted_at, ai.revoked_at
        FROM access_invitations ai WHERE ai.id = ${invitationId}`.execute(trx)).rows[0];
      return { invitation: toInvitation(row), emailDelivery: error.delivery };
    });
  }
}

/** Pending (also past expiry) → revoked. Used to correct a wrong address: revoke, then invite again. */
export async function revokeCentralAdminInvitation(userId: string, organizationId: string, invitationId: string): Promise<CentralAdminInvitation> {
  if (!invitationIdSchema.safeParse(organizationId).success || !invitationIdSchema.safeParse(invitationId).success) throw new PlatformAdminInvitationError("INVITATION_NOT_FOUND");
  return withPlatformContext(userId, async (trx) => {
    await requireOrganization(trx, organizationId, false);
    const current = (await sql<{ status: string }>`SELECT ai.status::text AS status FROM access_invitations ai
      WHERE ai.id = ${invitationId} AND ai.organization_id = ${organizationId} AND ${CENTRAL_SCOPE} FOR UPDATE OF ai`.execute(trx)).rows[0];
    if (!current) throw new PlatformAdminInvitationError("INVITATION_NOT_FOUND");
    if (current.status !== "pending") throw new PlatformAdminInvitationError("INVITATION_NOT_REVOCABLE");
    const updated = (await sql<Row>`UPDATE access_invitations AS ai SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE ai.id = ${invitationId} AND ai.status = 'pending'
      RETURNING ai.id, ai.email, ai.status::text AS status, ai.created_at, ai.expires_at, ai.accepted_at, ai.revoked_at`.execute(trx)).rows[0];
    if (!updated) throw new PlatformAdminInvitationError("INVITATION_NOT_REVOCABLE");
    await recordInvitationAudit(trx, userId, organizationId, invitationId, "ORG_ADMIN_INVITATION_REVOKED", {});
    return toInvitation(updated);
  });
}

import { sql } from "kysely";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import {
  withTenantContext,
  withUserContext,
  withTokenLookupContext,
  withNewMembershipContext,
} from "../../context/tenantContext.js";
import { RecipientNotFoundError } from "../careRecipients/careRecipients.service.js";

export class InvitationNotFoundError extends Error {
  constructor() {
    super("INVITATION_NOT_FOUND");
    this.name = "InvitationNotFoundError";
  }
}
export class InvitationExpiredError extends Error {
  constructor() {
    super("INVITATION_EXPIRED");
    this.name = "InvitationExpiredError";
  }
}
export class InvitationAlreadyUsedError extends Error {
  constructor(status: string) {
    super(`INVITATION_${status.toUpperCase()}`);
    this.name = "InvitationAlreadyUsedError";
  }
}
export class InvitationIdentityMismatchError extends Error {
  constructor() {
    super("INVITATION_IDENTITY_MISMATCH");
    this.name = "InvitationIdentityMismatchError";
  }
}
export class RelationshipNotFoundError extends Error {
  constructor() {
    super("RELATIONSHIP_NOT_FOUND");
    this.name = "RelationshipNotFoundError";
  }
}

const INVITATION_TTL_DAYS = 7;

function generateInvitationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export const createInvitationSchema = z.object({
  email: z.string().email(),
  relationshipType: z.string().min(1),
  canViewPhotos: z.boolean().default(true),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

interface InvitationRow {
  id: string;
  organization_id: string;
  care_recipient_id: string;
  email: string | null;
  phone: string | null;
  relationship_type: string;
  can_view_photos: boolean;
  status: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Creates a family invitation. Returns the raw token ONLY here, at
 * creation time -- exactly once, exactly like session tokens. It is never
 * retrievable again after this call returns; only its hash is persisted.
 */
export async function createFamilyInvitation(
  userId: string,
  organizationId: string,
  recipientId: string,
  input: CreateInvitationInput
): Promise<{ invitation: InvitationRow; rawToken: string }> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // Confirm the recipient is real and visible in this org context first,
    // so an admin cannot probe for the existence of a recipient in another
    // organization via this endpoint (RLS already prevents data leakage;
    // this turns it into a clean 404 at the service layer too).
    const recipientCheck = await sql<{ id: string }>`
      SELECT id FROM care_recipients WHERE id = ${recipientId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    if (!recipientCheck.rows[0]) throw new RecipientNotFoundError();

    const { rawToken, tokenHash } = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);

    const result = await sql<InvitationRow>`
      INSERT INTO family_invitations (
        organization_id, care_recipient_id, invited_by_user_id, email,
        relationship_type, can_view_photos, invitation_token_hash, expires_at
      ) VALUES (
        ${organizationId}, ${recipientId}, ${userId}, ${input.email},
        ${input.relationshipType}, ${input.canViewPhotos}, ${tokenHash}, ${expiresAt.toISOString()}
      )
      RETURNING id, organization_id, care_recipient_id, email, relationship_type,
                can_view_photos, status, expires_at, accepted_at, revoked_at, created_at
    `.execute(trx);

    return { invitation: result.rows[0], rawToken };
  });
}

interface RelationshipRow {
  id: string;
  user_id: string;
  organization_id: string;
  care_recipient_id: string;
  relationship_type: string;
  can_view_photos: boolean;
  status: string;
}

/**
 * Accepts a family invitation atomically: validates the token (via a
 * bootstrap lookup, since the accepting user has no membership yet in this
 * organization), then -- ONLY once validated -- creates or reuses the
 * membership, assigns the FAMILY role (loaded from DB by code, never
 * hardcoded), creates the family_relationship, and marks the invitation
 * accepted. All of it inside ONE transaction: any failure rolls back the
 * entire thing, leaving no partial membership/role/relationship behind.
 */
export async function acceptFamilyInvitation(
  userId: string,
  rawToken: string
): Promise<RelationshipRow> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // Step 1: bootstrap lookup -- find the invitation by token hash alone,
  // without any organization context (we don't know organizationId yet).
  const invitation = await withTokenLookupContext(tokenHash, async (trx) => {
    const result = await sql<InvitationRow>`
      SELECT id, organization_id, care_recipient_id, email, phone, relationship_type,
             can_view_photos, status, expires_at, accepted_at, revoked_at, created_at
      FROM family_invitations
      WHERE invitation_token_hash = ${tokenHash}
      LIMIT 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });

  if (!invitation) throw new InvitationNotFoundError();
  if (invitation.status === "revoked") throw new InvitationAlreadyUsedError("revoked");
  if (invitation.status === "accepted") throw new InvitationAlreadyUsedError("accepted");
  if (invitation.status === "expired" || new Date(invitation.expires_at).getTime() < Date.now()) {
    throw new InvitationExpiredError();
  }

  // Step 2: now that we know organization_id, do the whole acceptance as
  // ONE transaction using withNewMembershipContext -- the one sanctioned
  // exception to withTenantContext's pre-existing-membership requirement,
  // because creating that first membership is precisely what this step does.
  return withNewMembershipContext(userId, invitation.organization_id, async (trx) => {
    // CRITICAL: verify the AUTHENTICATED user's own email/phone matches
    // the invitation's target BEFORE creating anything. Possessing the raw
    // token is necessary but not sufficient -- someone who obtained the
    // token without being the intended recipient (forwarded, leaked) must
    // never be able to accept on someone else's behalf.
    const selfUser = await sql<{ email: string | null; phone: string | null }>`
      SELECT email, phone FROM users WHERE id = ${userId} LIMIT 1
    `.execute(trx);
    const self = selfUser.rows[0];
    const emailMatches =
      invitation.email && self?.email && invitation.email.toLowerCase() === self.email.toLowerCase();
    const phoneMatches = invitation.phone && self?.phone && invitation.phone === self.phone;
    if (!emailMatches && !phoneMatches) {
      throw new InvitationIdentityMismatchError();
    }

    // Re-check the invitation's live status INSIDE this transaction too
    // (defense against a race between step 1 and step 2).
    const recheck = await sql<{ status: string; expires_at: string }>`
      SELECT status, expires_at FROM family_invitations WHERE id = ${invitation.id} LIMIT 1
    `.execute(trx);
    const live = recheck.rows[0];
    if (!live || live.status !== "pending" || new Date(live.expires_at).getTime() < Date.now()) {
      throw new InvitationExpiredError();
    }

    // Reuse an existing membership if present; never silently reactivate a
    // revoked one -- that is an explicit policy decision (section 17).
    const existingMembership = await sql<{ id: string; status: string }>`
      SELECT id, status FROM organization_memberships
      WHERE user_id = ${userId} AND organization_id = ${invitation.organization_id}
      LIMIT 1
    `.execute(trx);

    let membershipId: string;
    if (existingMembership.rows[0]) {
      if (existingMembership.rows[0].status === "revoked") {
        const err = new Error("MEMBERSHIP_REVOKED_REQUIRES_MANUAL_REACTIVATION");
        err.name = "MembershipRevokedError";
        throw err;
      }
      membershipId = existingMembership.rows[0].id;
    } else {
      const inserted = await sql<{ id: string }>`
        INSERT INTO organization_memberships (user_id, organization_id, status)
        VALUES (${userId}, ${invitation.organization_id}, 'active')
        RETURNING id
      `.execute(trx);
      membershipId = inserted.rows[0].id;
    }

    // FAMILY role loaded from DB by code, never hardcoded as an id.
    const familyRole = await sql<{ id: string }>`
      SELECT id FROM roles WHERE code = 'FAMILY' LIMIT 1
    `.execute(trx);
    if (!familyRole.rows[0]) {
      throw new Error("FAMILY role not seeded -- cannot proceed");
    }

    // Don't duplicate the role assignment if it already exists (idempotent
    // re-acceptance scenario, e.g. a second invitation for a different
    // recipient in the same org).
    const existingRole = await sql<{ id: string }>`
      SELECT id FROM user_roles
      WHERE organization_membership_id = ${membershipId} AND role_id = ${familyRole.rows[0].id}
      LIMIT 1
    `.execute(trx);
    if (!existingRole.rows[0]) {
      await sql`
        INSERT INTO user_roles (organization_membership_id, organization_id, role_id)
        VALUES (${membershipId}, ${invitation.organization_id}, ${familyRole.rows[0].id})
      `.execute(trx);
    }

    // family_relationships has a UNIQUE (user_id, care_recipient_id)
    // constraint already -- re-accepting for the same recipient would
    // violate it. Check first for a clean, explicit conflict instead of a
    // raw constraint-violation error.
    const existingRelationship = await sql<{ id: string }>`
      SELECT id FROM family_relationships
      WHERE user_id = ${userId} AND care_recipient_id = ${invitation.care_recipient_id}
      LIMIT 1
    `.execute(trx);
    if (existingRelationship.rows[0]) {
      const err = new Error("RELATIONSHIP_ALREADY_EXISTS");
      err.name = "RelationshipAlreadyExistsError";
      throw err;
    }

    const relationshipResult = await sql<RelationshipRow>`
      INSERT INTO family_relationships (
        user_id, organization_id, care_recipient_id, invitation_id,
        relationship_type, can_view_photos, status
      ) VALUES (
        ${userId}, ${invitation.organization_id}, ${invitation.care_recipient_id}, ${invitation.id},
        ${invitation.relationship_type}, ${invitation.can_view_photos}, 'active'
      )
      RETURNING id, user_id, organization_id, care_recipient_id, relationship_type, can_view_photos, status
    `.execute(trx);

    await sql`
      UPDATE family_invitations
      SET status = 'accepted', accepted_at = now()
      WHERE id = ${invitation.id}
    `.execute(trx);

    return relationshipResult.rows[0];
  });
}

export async function revokeFamilyRelationship(
  userId: string,
  organizationId: string,
  relationshipId: string
): Promise<void> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{ id: string }>`
      UPDATE family_relationships
      SET status = 'revoked', revoked_at = now()
      WHERE id = ${relationshipId} AND organization_id = ${organizationId}
      RETURNING id
    `.execute(trx);
    if (!result.rows[0]) throw new RelationshipNotFoundError();
  });
}

/**
 * Reusable authorization check (section 23): returns true only when an
 * active membership, an active family_relationship, AND can_view_photos
 * are all simultaneously true. Never trusts a client-supplied value.
 */
export async function canFamilyViewPhotos(
  userId: string,
  organizationId: string,
  recipientId: string
): Promise<boolean> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{ can_view_photos: boolean }>`
      SELECT can_view_photos FROM family_relationships
      WHERE user_id = ${userId}
        AND care_recipient_id = ${recipientId}
        AND organization_id = ${organizationId}
        AND status = 'active'
      LIMIT 1
    `.execute(trx);
    return result.rows[0]?.can_view_photos === true;
  }).catch(() => false); // any authorization failure (incl. no membership) => false, never throws
}

interface MyRecipientRow {
  organizationId: string;
  recipientId: string;
  relationshipType: string;
  canViewPhotos: boolean;
  firstName: string;
  lastName: string;
  preferredName: string | null;
}

/**
 * GET /me/care-recipients: discovers every (org, recipient) pair the user
 * has an ACTIVE family_relationship for, across ALL organizations, then
 * re-reads each recipient through the normal per-org withTenantContext +
 * existing care_recipients RLS (never bypassing it) to get the actual data.
 */
export async function listMyCareRecipients(userId: string): Promise<MyRecipientRow[]> {
  const relationships = await withUserContext(userId, async (trx) => {
    const result = await sql<{
      organization_id: string;
      care_recipient_id: string;
      relationship_type: string;
      can_view_photos: boolean;
    }>`
      SELECT organization_id, care_recipient_id, relationship_type, can_view_photos
      FROM family_relationships
      WHERE user_id = ${userId} AND status = 'active'
    `.execute(trx);
    return result.rows;
  });

  const out: MyRecipientRow[] = [];
  for (const rel of relationships) {
    try {
      const recipient = await withTenantContext(
        { userId, organizationId: rel.organization_id },
        async (trx) => {
          const r = await sql<{ first_name: string; last_name: string; preferred_name: string | null }>`
            SELECT first_name, last_name, preferred_name FROM care_recipients
            WHERE id = ${rel.care_recipient_id} AND organization_id = ${rel.organization_id}
            LIMIT 1
          `.execute(trx);
          return r.rows[0];
        }
      );
      if (recipient) {
        out.push({
          organizationId: rel.organization_id,
          recipientId: rel.care_recipient_id,
          relationshipType: rel.relationship_type,
          canViewPhotos: rel.can_view_photos,
          firstName: recipient.first_name,
          lastName: recipient.last_name,
          preferredName: recipient.preferred_name,
        });
      }
    } catch {
      // Membership no longer active in that org -- silently excluded, not
      // an error for the overall request.
    }
  }
  return out;
}

export async function getMyCareRecipient(userId: string, recipientId: string): Promise<MyRecipientRow> {
  const parsedId = z.string().uuid().safeParse(recipientId);
  if (!parsedId.success) throw new RecipientNotFoundError();

  const relationship = await withUserContext(userId, async (trx) => {
    const result = await sql<{
      organization_id: string;
      care_recipient_id: string;
      relationship_type: string;
      can_view_photos: boolean;
    }>`
      SELECT organization_id, care_recipient_id, relationship_type, can_view_photos
      FROM family_relationships
      WHERE user_id = ${userId} AND care_recipient_id = ${recipientId} AND status = 'active'
      LIMIT 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });

  if (!relationship) throw new RecipientNotFoundError();

  // Any failure here (including the org membership no longer being active)
  // must present identically to "not found" -- never leak WHY access was
  // denied, for the same anti-enumeration reason established elsewhere in
  // this codebase (section 27).
  try {
    return await withTenantContext(
      { userId, organizationId: relationship.organization_id },
      async (trx) => {
        const r = await sql<{ first_name: string; last_name: string; preferred_name: string | null }>`
          SELECT first_name, last_name, preferred_name FROM care_recipients
          WHERE id = ${relationship.care_recipient_id} AND organization_id = ${relationship.organization_id}
          LIMIT 1
        `.execute(trx);
        if (!r.rows[0]) throw new RecipientNotFoundError();
        return {
          organizationId: relationship.organization_id,
          recipientId: relationship.care_recipient_id,
          relationshipType: relationship.relationship_type,
          canViewPhotos: relationship.can_view_photos,
          firstName: r.rows[0].first_name,
          lastName: r.rows[0].last_name,
          preferredName: r.rows[0].preferred_name,
        };
      }
    );
  } catch {
    throw new RecipientNotFoundError();
  }
}

import { Router, type Response } from "express";
import { z } from "zod";
import {
  createFamilyInvitation,
  acceptFamilyInvitation,
  revokeFamilyRelationship,
  listMyCareRecipients,
  getMyCareRecipient,
  createInvitationSchema,
  InvitationNotFoundError,
  InvitationExpiredError,
  InvitationAlreadyUsedError,
  InvitationIdentityMismatchError,
  RelationshipNotFoundError,
} from "./family.service.js";
import { RecipientNotFoundError } from "../careRecipients/careRecipients.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleTenantError(err: unknown, res: Response): boolean {
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
    return true;
  }
  if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) {
    res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    return true;
  }
  if (err instanceof RecipientNotFoundError || err instanceof RelationshipNotFoundError) {
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/care-recipients/:recipientId/family-invitations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const recipientIdParsed = uuidParam.safeParse(req.params.recipientId);
    if (!orgIdParsed.success || !recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    const bodyParsed = createInvitationSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const { invitation, rawToken } = await createFamilyInvitation(
        req.auth!.userId,
        orgIdParsed.data,
        recipientIdParsed.data,
        bodyParsed.data
      );
      // rawToken returned here ONLY -- this is the one-time disclosure,
      // exactly like a session token at login. In a real deployment this
      // would be delivered via an email link, never re-readable via API
      // afterward. Returned directly here because no email integration
      // exists yet in this gate's scope, matching the instructions.
      res.status(201).json({ invitation, token: rawToken });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

const acceptSchema = z.object({ token: z.string().min(1) });

router.post("/family-invitations/accept", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const bodyParsed = acceptSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "INVALID_PAYLOAD" });
    return;
  }
  try {
    const relationship = await acceptFamilyInvitation(req.auth!.userId, bodyParsed.data.token);
    res.status(200).json({ relationship });
  } catch (err) {
    if (err instanceof InvitationNotFoundError) {
      res.status(404).json({ error: "INVITATION_NOT_FOUND" });
      return;
    }
    if (err instanceof InvitationExpiredError) {
      res.status(410).json({ error: "INVITATION_EXPIRED" });
      return;
    }
    if (err instanceof InvitationIdentityMismatchError) {
      // 403, not 404 -- the invitation genuinely exists and the token is
      // valid; this specific authenticated identity simply isn't the
      // intended recipient. Message is generic, never reveals the actual
      // target email/phone.
      res.status(403).json({ error: "INVITATION_IDENTITY_MISMATCH" });
      return;
    }
    if (err instanceof InvitationAlreadyUsedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.name === "MembershipRevokedError") {
      res.status(409).json({ error: "MEMBERSHIP_REVOKED_REQUIRES_MANUAL_REACTIVATION" });
      return;
    }
    if (err instanceof Error && err.name === "RelationshipAlreadyExistsError") {
      res.status(409).json({ error: "RELATIONSHIP_ALREADY_EXISTS" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post(
  "/organizations/:organizationId/care-recipients/:recipientId/family/:relationshipId/revoke",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const relationshipIdParsed = uuidParam.safeParse(req.params.relationshipId);
    if (!orgIdParsed.success || !relationshipIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    try {
      await revokeFamilyRelationship(req.auth!.userId, orgIdParsed.data, relationshipIdParsed.data);
      res.status(200).json({ ok: true });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get("/me/care-recipients", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const recipients = await listMyCareRecipients(req.auth!.userId);
  res.status(200).json({ recipients });
});

router.get(
  "/me/care-recipients/:recipientId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const recipientIdParsed = uuidParam.safeParse(req.params.recipientId);
    if (!recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    try {
      const recipient = await getMyCareRecipient(req.auth!.userId, recipientIdParsed.data);
      res.status(200).json({ recipient });
    } catch (err) {
      if (err instanceof RecipientNotFoundError) {
        res.status(404).json({ error: "RECIPIENT_NOT_FOUND" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

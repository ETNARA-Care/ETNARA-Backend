import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import {
  AccessInvitationError,
  AccessInvitationForbiddenError,
  acceptAccessInvitation,
  activateAccessInvitation,
  activateAccessInvitationSchema,
  createAccessInvitation,
  createAccessInvitationSchema,
  deactivateInvitedAccess,
  inspectAccessInvitation,
  listAccessInvitations,
  renewAccessInvitation,
  revokeAccessInvitation,
} from "./accessInvitations.service.js";

const router = Router();
const uuid = z.string().uuid();
const tokenSchema = z.object({ token: z.string().length(64) });

function statusForCode(code: string) {
  if (["INVITATION_NOT_AVAILABLE", "TARGET_NOT_FOUND"].includes(code)) return 404;
  if (code === "INVITATION_EXPIRED") return 410;
  if (["INVITATION_IDENTITY_MISMATCH", "ACCOUNT_DISABLED", "WORKER_NOT_ACTIVE", "RECIPIENT_NOT_ACTIVE"].includes(code)) return 403;
  return 409;
}

function handleError(error: unknown, res: Response) {
  if (error instanceof AccessInvitationForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: "ACCESS_INVITATION_FORBIDDEN" });
    return;
  }
  if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
    return;
  }
  if (error instanceof AccessInvitationError) {
    res.status(statusForCode(error.code)).json({ error: error.code });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

router.post("/access-invitations/inspect", async (req: Request, res: Response) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    res.status(200).json({ invitation: await inspectAccessInvitation(parsed.data.token) });
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/access-invitations/activate", async (req: Request, res: Response) => {
  const parsed = activateAccessInvitationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    res.status(200).json({ activation: await activateAccessInvitation(parsed.data.token, parsed.data.password) });
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/access-invitations/accept", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    res.status(200).json({ activation: await acceptAccessInvitation(req.auth!.userId, parsed.data.token) });
  } catch (error) {
    handleError(error, res);
  }
});

router.post(
  "/organizations/:organizationId/access-invitations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuid.safeParse(req.params.organizationId);
    const body = createAccessInvitationSchema.safeParse(req.body);
    if (!organizationId.success || !body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
    try {
      const result = await createAccessInvitation(req.auth!.userId, organizationId.data, body.data);
      res.status(201).json({ invitation: result.invitation, token: result.rawToken });
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/organizations/:organizationId/access-invitations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuid.safeParse(req.params.organizationId);
    const workerMembershipId = req.query.workerMembershipId ? uuid.safeParse(req.query.workerMembershipId) : null;
    const careRecipientId = req.query.careRecipientId ? uuid.safeParse(req.query.careRecipientId) : null;
    if (!organizationId.success || workerMembershipId?.success === false || careRecipientId?.success === false) {
      return void res.status(400).json({ error: "INVALID_ID" });
    }
    try {
      const invitations = await listAccessInvitations(req.auth!.userId, organizationId.data, {
        workerMembershipId: workerMembershipId?.data,
        careRecipientId: careRecipientId?.data,
      });
      res.status(200).json({ invitations });
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.post(
  "/organizations/:organizationId/access-invitations/:invitationId/revoke",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuid.safeParse(req.params.organizationId);
    const invitationId = uuid.safeParse(req.params.invitationId);
    if (!organizationId.success || !invitationId.success) return void res.status(400).json({ error: "INVALID_ID" });
    try {
      await revokeAccessInvitation(req.auth!.userId, organizationId.data, invitationId.data);
      res.status(200).json({ ok: true });
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.post(
  "/organizations/:organizationId/access-invitations/:invitationId/deactivate",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuid.safeParse(req.params.organizationId);
    const invitationId = uuid.safeParse(req.params.invitationId);
    if (!organizationId.success || !invitationId.success) return void res.status(400).json({ error: "INVALID_ID" });
    try {
      await deactivateInvitedAccess(req.auth!.userId, organizationId.data, invitationId.data);
      res.status(200).json({ ok: true });
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.post(
  "/organizations/:organizationId/access-invitations/:invitationId/renew",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuid.safeParse(req.params.organizationId);
    const invitationId = uuid.safeParse(req.params.invitationId);
    if (!organizationId.success || !invitationId.success) return void res.status(400).json({ error: "INVALID_ID" });
    try {
      const result = await renewAccessInvitation(req.auth!.userId, organizationId.data, invitationId.data);
      res.status(200).json({ invitation: result.invitation, token: result.rawToken });
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;

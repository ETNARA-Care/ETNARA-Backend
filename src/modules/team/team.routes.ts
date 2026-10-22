import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import {
  TeamForbiddenError,
  TeamInvitationError,
  inviteTeamMember,
  inviteTeamMemberSchema,
  listTeam,
  revokeTeamInvitation,
  setStaffRole,
  setStaffRoleSchema,
} from "./team.service.js";

const router = Router();
const uuid = z.string().uuid();

function handleError(error: unknown, res: Response) {
  if (error instanceof TeamForbiddenError || error instanceof MembershipNotActiveError) {
    res.status(403).json({ error: "TEAM_FORBIDDEN" });
    return;
  }
  if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
    return;
  }
  if (error instanceof TeamInvitationError) {
    const status = error.code === "INVITATION_NOT_FOUND" || error.code === "MEMBER_NOT_FOUND" ? 404 : 409;
    res.status(status).json({ error: error.code });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

router.get("/organizations/:organizationId/team", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  try {
    res.status(200).json(await listTeam(req.auth!.userId, org.data));
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/organizations/:organizationId/team/invitations", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  const body = inviteTeamMemberSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    res.status(201).json(await inviteTeamMember(req.auth!.userId, org.data, body.data));
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/organizations/:organizationId/team/invitations/:invitationId/revoke", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  const invitation = uuid.safeParse(req.params.invitationId);
  if (!org.success || !invitation.success) return void res.status(400).json({ error: "INVALID_ID" });
  try {
    res.status(200).json(await revokeTeamInvitation(req.auth!.userId, org.data, invitation.data));
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/organizations/:organizationId/team/roles", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const org = uuid.safeParse(req.params.organizationId);
  if (!org.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
  const body = setStaffRoleSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "INVALID_PAYLOAD" });
  try {
    res.status(200).json(await setStaffRole(req.auth!.userId, org.data, body.data));
  } catch (error) {
    handleError(error, res);
  }
});

export default router;

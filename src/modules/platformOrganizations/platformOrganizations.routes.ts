import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";
import {
  activateOrganizationAdminInvitation,
  activateOrganizationAdminInvitationSchema,
  createPlatformOrganization,
  createPlatformOrganizationSchema,
  inspectOrganizationAdminInvitation,
  inviteOrganizationAdmin,
  inviteOrganizationAdminSchema,
  listPlatformOrganizations,
  OrganizationAdminInvitationError,
  organizationAdminInvitationTokenSchema,
} from "./platformOrganizations.service.js";

const router = Router();

function handle(error: unknown, res: Response) {
  if (error instanceof UnauthorizedPlatformAccessError) {
    res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
    return;
  }
  if (error instanceof OrganizationAdminInvitationError) {
    const status = error.code === "ACCOUNT_ALREADY_EXISTS" ? 409 : 400;
    res.status(status).json({ error: error.code });
    return;
  }
  if (error instanceof Error && error.message === "ORGANIZATION_NOT_FOUND") {
    res.status(404).json({ error: "ORGANIZATION_NOT_FOUND" });
    return;
  }
  if (error instanceof Error && error.message === "INVITATION_ALREADY_PENDING") {
    res.status(409).json({ error: "INVITATION_ALREADY_PENDING" });
    return;
  }
  console.error(
    "Unexpected platform organization failure",
    error instanceof Error ? { name: error.name, message: error.message } : {}
  );
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

router.get("/platform/organizations", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    res.json({ organizations: await listPlatformOrganizations(req.auth!.userId) });
  } catch (error) {
    handle(error, res);
  }
});

router.post("/platform/organizations", requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = createPlatformOrganizationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_ORGANIZATION" });
  try {
    res.status(201).json({ organization: await createPlatformOrganization(req.auth!.userId, parsed.data) });
  } catch (error) {
    handle(error, res);
  }
});

router.post(
  "/platform/organizations/:organizationId/admin-invitations",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const parsed = inviteOrganizationAdminSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "INVALID_INVITATION" });
    const organizationId = Array.isArray(req.params.organizationId) ? req.params.organizationId[0] : req.params.organizationId;
    if (!organizationId) return void res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    try {
      const result = await inviteOrganizationAdmin(req.auth!.userId, organizationId, parsed.data.email);
      res.status(201).json({
        invitation: result.invitation,
        activationToken: result.rawToken,
        emailDelivery: result.emailDelivery,
      });
    } catch (error) {
      handle(error, res);
    }
  }
);

router.get("/platform/admin-invitations/inspect", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const parsed = organizationAdminInvitationTokenSchema.safeParse({ token });
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_INVITATION" });
  try {
    res.json({ invitation: await inspectOrganizationAdminInvitation(parsed.data.token) });
  } catch (error) {
    handle(error, res);
  }
});

router.post("/platform/admin-invitations/activate", async (req, res) => {
  const parsed = activateOrganizationAdminInvitationSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "INVALID_ACTIVATION" });
  try {
    const activation = await activateOrganizationAdminInvitation(parsed.data.token, parsed.data.password);
    res.status(201).json({ activation });
  } catch (error) {
    handle(error, res);
  }
});

export default router;

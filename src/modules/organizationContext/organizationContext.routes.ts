import { Router, type Response } from "express";
import { z } from "zod";
import {
  getMe,
  getMyWorkerProfile,
  validateOrganizationSelection,
  InvalidOrganizationIdError,
  OrganizationAccessDeniedError,
} from "./organizationContext.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";

const router = Router();

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const result = await getMe(req.auth!.userId);
  res.status(200).json(result);
});

const activeOrgSchema = z.object({ organizationId: z.string() });

router.get(
  "/organizations/:organizationId/me/worker-profile",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const workerProfile = await getMyWorkerProfile(
        req.auth!.userId,
        String(req.params.organizationId)
      );
      res.status(200).json({ workerProfile });
    } catch (err) {
      if (err instanceof InvalidTenantContextError) {
        res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
        return;
      }
      if (err instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/me/active-organization",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = activeOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const organization = await validateOrganizationSelection(
        req.auth!.userId,
        parsed.data.organizationId
      );
      res.status(200).json({ organization });
    } catch (err) {
      if (err instanceof InvalidOrganizationIdError) {
        res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
        return;
      }
      if (err instanceof OrganizationAccessDeniedError) {
        res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

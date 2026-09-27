import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  CareQualityAgentForbiddenError,
  generateCareQualityAgentBriefing,
} from "./careQualityAgent.service.js";

const router = Router();
const uuid = z.string().uuid();

router.post(
  "/organizations/:organizationId/care-quality/agent/briefing",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const organization = uuid.safeParse(req.params.organizationId);
    if (!organization.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      res.status(201).json(
        await generateCareQualityAgentBriefing(req.auth!.userId, organization.data)
      );
    } catch (error) {
      res.status(error instanceof CareQualityAgentForbiddenError ? 403 : 500).json({
        error: error instanceof CareQualityAgentForbiddenError ? error.message : "INTERNAL_ERROR",
      });
    }
  }
);

export default router;

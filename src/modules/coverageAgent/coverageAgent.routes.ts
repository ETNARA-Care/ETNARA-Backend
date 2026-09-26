import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  CoverageAgentForbiddenError,
  generateCoverageAgentBriefing,
} from "./coverageAgent.service.js";

const router = Router();
const uuid = z.string().uuid();

router.post(
  "/organizations/:organizationId/coverage/agent/briefing",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const organization = uuid.safeParse(req.params.organizationId);
    if (!organization.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      res.status(201).json(
        await generateCoverageAgentBriefing(req.auth!.userId, organization.data)
      );
    } catch (error) {
      res.status(error instanceof CoverageAgentForbiddenError ? 403 : 500).json({
        error: error instanceof CoverageAgentForbiddenError ? error.message : "INTERNAL_ERROR",
      });
    }
  }
);

export default router;

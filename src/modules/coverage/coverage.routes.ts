import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { OrganizationAccessDeniedError } from "../organizationContext/organizationContext.service.js";
import {
  CoverageRecommendationForbiddenError,
  CoverageRecipientNotFoundError,
  coverageRecommendationSchema,
  recommendCoverage,
} from "./coverage.service.js";

const router = Router();
const uuidParam = z.string().uuid();

router.post(
  "/organizations/:organizationId/coverage/recommendations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const input = coverageRecommendationSchema.safeParse(req.body);
    if (!organizationId.success || !input.success) {
      res.status(400).json({ error: "INVALID_COVERAGE_REQUEST" });
      return;
    }

    try {
      const candidates = await recommendCoverage(req.auth!.userId, organizationId.data, input.data);
      res.status(200).json({ candidates });
    } catch (error) {
      if (error instanceof CoverageRecommendationForbiddenError || error instanceof MembershipNotActiveError || error instanceof OrganizationAccessDeniedError) {
        res.status(403).json({ error: "COVERAGE_RECOMMENDATION_FORBIDDEN" });
        return;
      }
      if (error instanceof CoverageRecipientNotFoundError) {
        res.status(404).json({ error: "CARE_RECIPIENT_NOT_FOUND" });
        return;
      }
      if (error instanceof InvalidTenantContextError) {
        res.status(400).json({ error: "INVALID_ID" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

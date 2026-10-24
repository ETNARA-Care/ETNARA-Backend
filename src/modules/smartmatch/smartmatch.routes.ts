import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError } from "../../context/errors.js";
import { smartMatchPublishSchema } from "./smartmatch.schemas.js";
import {
  publishInternalOpportunity, listAgencyOpportunities, activateInternalOpportunity,
  SmartMatchForbiddenError, SmartMatchNetworkDisabledError, listAgencyApplicationCounts, listAgencyPendingApplications,
  listCaregiverInternalOpportunities,
} from "./smartmatch.service.js";

const router = Router();
const uuid = z.string().uuid();

router.post("/organizations/:organizationId/smartmatch/opportunities",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const body = smartMatchPublishSchema.safeParse(req.body);
    if (!org.success || !body.success) {
      const issue = body.success ? undefined
        : body.error.issues.map((i) => i.message).find((m) => m === "OPPORTUNITY_TOO_LONG" || m === "OPPORTUNITY_IN_PAST");
      res.status(400).json({ error: issue ?? "INVALID_REQUEST" }); return;
    }
    try {
      const opportunity = await publishInternalOpportunity(req.auth!.userId, org.data, body.data);
      res.status(201).json({ opportunity });
    } catch (error) {
      if (error instanceof SmartMatchNetworkDisabledError) {
        res.status(409).json({ error: "NETWORK_NOT_ENABLED" }); return;
      }
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

router.get("/organizations/:organizationId/smartmatch/opportunities",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const opportunities = await listAgencyOpportunities(req.auth!.userId, org.data);
      res.status(200).json({ opportunities });
    } catch (error) {
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

router.post("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/publish",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const opportunity = uuid.safeParse(req.params.opportunityId);
    if (!org.success || !opportunity.success) {
      res.status(400).json({ error: "INVALID_ID" }); return;
    }
    try {
      const result = await activateInternalOpportunity(
        req.auth!.userId, org.data, opportunity.data,
      );
      if (!result) { res.status(404).json({ error: "NOT_FOUND_OR_NOT_PUBLISHABLE" }); return; }
      res.status(200).json({ opportunity: result });
    } catch (error) {
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });


router.get("/organizations/:organizationId/smartmatch/application-counts",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const counts = await listAgencyApplicationCounts(req.auth!.userId, org.data);
      res.status(200).json({ counts });
    } catch (error) {
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });


router.get("/organizations/:organizationId/smartmatch/opportunities/:opportunityId/applications",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const opportunity = uuid.safeParse(req.params.opportunityId);
    if (!org.success || !opportunity.success) {
      res.status(400).json({ error: "INVALID_ID" }); return;
    }
    try {
      const applications = await listAgencyPendingApplications(
        req.auth!.userId, org.data, opportunity.data,
      );
      res.status(200).json({ applications });
    } catch (error) {
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });


/** Read-only caregiver discovery, restricted to their own active agency. */
router.get("/organizations/:organizationId/smartmatch/available-opportunities",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    if (!org.success) { res.status(400).json({ error: "INVALID_ID" }); return; }
    try {
      const opportunities = await listCaregiverInternalOpportunities(req.auth!.userId, org.data);
      res.status(200).json({ opportunities });
    } catch (error) {
      if (error instanceof SmartMatchForbiddenError || error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

export default router;

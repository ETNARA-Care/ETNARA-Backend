import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { MembershipNotActiveError } from "../../context/errors.js";
import { smartMatchPublishSchema } from "./smartmatch.schemas.js";
import {
  publishInternalOpportunity, listAgencyOpportunities,
  SmartMatchForbiddenError, SmartMatchNetworkDisabledError,
} from "./smartmatch.service.js";

const router = Router();
const uuid = z.string().uuid();

router.post("/organizations/:organizationId/smartmatch/opportunities",
  requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const org = uuid.safeParse(req.params.organizationId);
    const body = smartMatchPublishSchema.safeParse(req.body);
    if (!org.success || !body.success) {
      res.status(400).json({ error: "INVALID_REQUEST" }); return;
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
      if (error instanceof MembershipNotActiveError) {
        res.status(403).json({ error: "FORBIDDEN" }); return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

export default router;

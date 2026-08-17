import { Router, type Response } from "express";
import { z } from "zod";
import {
  getFamilyTimeline,
  timelineQuerySchema,
  RecipientNotFoundError,
  InvalidDateRangeError,
} from "./familyTimeline.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

const router = Router();
const uuidParam = z.string().uuid();

router.get(
  "/organizations/:organizationId/care-recipients/:careRecipientId/timeline",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const recipientIdParsed = uuidParam.safeParse(req.params.careRecipientId);
    if (!recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_RECIPIENT_ID" });
      return;
    }
    const queryParsed = timelineQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: "INVALID_QUERY" });
      return;
    }
    try {
      const result = await getFamilyTimeline(
        req.auth!.userId,
        orgIdParsed.data,
        recipientIdParsed.data,
        queryParsed.data
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
        res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
        return;
      }
      if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) {
        res.status(400).json({ error: "INVALID_ID" });
        return;
      }
      if (err instanceof RecipientNotFoundError) {
        res.status(404).json({ error: "RECIPIENT_NOT_FOUND" });
        return;
      }
      if (err instanceof InvalidDateRangeError) {
        res.status(400).json({ error: "INVALID_DATE_RANGE" });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

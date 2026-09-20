import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { OrganizationAccessDeniedError } from "../organizationContext/organizationContext.service.js";
import {
  AvailabilityWorkerNotLinkedError,
  getMyAvailability,
  replaceMyAvailability,
  replaceMyAvailabilitySchema,
} from "./availability.service.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleAvailabilityError(error: unknown, res: Response): boolean {
  if (error instanceof MembershipNotActiveError || error instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
    return true;
  }
  if (error instanceof AvailabilityWorkerNotLinkedError) {
    res.status(404).json({ error: "WORKER_NOT_LINKED" });
    return true;
  }
  if (error instanceof InvalidTenantContextError) {
    res.status(400).json({ error: "INVALID_ID" });
    return true;
  }
  return false;
}

router.get(
  "/organizations/:organizationId/me/availability",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    if (!organizationId.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const availability = await getMyAvailability(req.auth!.userId, organizationId.data);
      res.status(200).json({ availability });
    } catch (error) {
      if (!handleAvailabilityError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.put(
  "/organizations/:organizationId/me/availability",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const organizationId = uuidParam.safeParse(req.params.organizationId);
    const input = replaceMyAvailabilitySchema.safeParse(req.body);
    if (!organizationId.success || !input.success) {
      res.status(400).json({ error: "INVALID_AVAILABILITY" });
      return;
    }
    try {
      const availability = await replaceMyAvailability(req.auth!.userId, organizationId.data, input.data);
      res.status(200).json({ availability });
    } catch (error) {
      if (!handleAvailabilityError(error, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

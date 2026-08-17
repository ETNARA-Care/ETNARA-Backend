import { Router, type Response } from "express";
import { z } from "zod";
import {
  createCareEvent,
  listShiftCareEvents,
  listRecipientCareEvents,
  createCareEventSchema,
  WorkerNotLinkedError,
  ShiftNotFoundError,
  NoActiveVisitError,
  RecipientNotInContextError,
  EventTypeNotEnabledError,
  InvalidFileForPhotoError,
} from "./careEvents.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

const router = Router();
const uuidParam = z.string().uuid();

function handleError(err: unknown, res: Response): boolean {
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
    return true;
  }
  if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) {
    res.status(400).json({ error: "INVALID_ID" });
    return true;
  }
  if (err instanceof WorkerNotLinkedError) {
    res.status(403).json({ error: "USER_HAS_NO_WORKER_PROFILE" });
    return true;
  }
  if (err instanceof ShiftNotFoundError) {
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof NoActiveVisitError) {
    res.status(409).json({ error: "NO_ACTIVE_VISIT" });
    return true;
  }
  if (err instanceof RecipientNotInContextError) {
    // 404, not 403: no enumeration signal about whether the recipient
    // exists elsewhere in the org.
    res.status(404).json({ error: "RECIPIENT_NOT_IN_SHIFT_CONTEXT" });
    return true;
  }
  if (err instanceof EventTypeNotEnabledError) {
    res.status(409).json({ error: "EVENT_TYPE_NOT_ENABLED" });
    return true;
  }
  if (err instanceof InvalidFileForPhotoError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof Error && err.name === "InvalidPayloadError") {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/shifts/:shiftId/care-events",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createCareEventSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const event = await createCareEvent(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.shiftId),
        bodyParsed.data
      );
      res.status(201).json({ event });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/shifts/:shiftId/care-events",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const events = await listShiftCareEvents(req.auth!.userId, orgIdParsed.data, String(req.params.shiftId));
      res.status(200).json({ events });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/care-recipients/:careRecipientId/care-events",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const events = await listRecipientCareEvents(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.careRecipientId)
      );
      res.status(200).json({ events });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

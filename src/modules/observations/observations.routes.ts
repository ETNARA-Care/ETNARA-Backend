import { Router, type Response } from "express";
import { z } from "zod";
import {
  createObservation,
  listObservations,
  getObservation,
  markObservationReviewed,
  createObservationSchema,
  WorkerNotLinkedError,
  RecipientNotFoundError,
  ObservationNotFoundError,
  CareEventNotInContextError,
  NotOrgManagerError,
  InvalidObservationStatusTransitionError,
} from "./observations.service.js";
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
  if (err instanceof RecipientNotFoundError || err instanceof ObservationNotFoundError) {
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof CareEventNotInContextError) {
    res.status(400).json({ error: "CARE_EVENT_NOT_IN_CONTEXT" });
    return true;
  }
  if (err instanceof NotOrgManagerError) {
    res.status(403).json({ error: "REQUIRES_ORG_MANAGER" });
    return true;
  }
  if (err instanceof InvalidObservationStatusTransitionError) {
    res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/observations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createObservationSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const observation = await createObservation(req.auth!.userId, orgIdParsed.data, bodyParsed.data);
      res.status(201).json({ observation });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/observations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const observations = await listObservations(req.auth!.userId, orgIdParsed.data, {
        careRecipientId: req.query.careRecipientId as string | undefined,
        status: req.query.status as string | undefined,
      });
      res.status(200).json({ observations });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/observations/:observationId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const observation = await getObservation(req.auth!.userId, orgIdParsed.data, String(req.params.observationId));
      res.status(200).json({ observation });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/observations/:observationId/review",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const observation = await markObservationReviewed(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.observationId)
      );
      res.status(200).json({ observation });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

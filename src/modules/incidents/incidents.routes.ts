import { Router, type Response } from "express";
import { z } from "zod";
import {
  createIncident,
  escalateObservationToIncident,
  listIncidents,
  getIncident,
  listFamilyIncidents,
  updateIncidentStatus,
  assignIncident,
  addTimelineEntry,
  listTimelineEntries,
  addIncidentAttachment,
  listIncidentAttachments,
  createIncidentSchema,
  escalateObservationSchema,
  addTimelineEntrySchema,
  addAttachmentSchema,
  WorkerNotLinkedError,
  RecipientNotFoundError,
  IncidentNotFoundError,
  ObservationNotFoundError,
  ObservationAlreadyEscalatedError,
  NotOrgManagerError,
  InvalidStatusTransitionError,
  InvalidFileForAttachmentError,
  AssigneeNotInOrgError,
  FamilyMustUseFamilyEndpointError,
} from "./incidents.service.js";
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
  if (
    err instanceof RecipientNotFoundError ||
    err instanceof IncidentNotFoundError ||
    err instanceof ObservationNotFoundError
  ) {
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof ObservationAlreadyEscalatedError) {
    res.status(409).json({ error: "OBSERVATION_ALREADY_ESCALATED" });
    return true;
  }
  if (err instanceof NotOrgManagerError) {
    res.status(403).json({ error: "REQUIRES_ORG_MANAGER" });
    return true;
  }
  if (err instanceof InvalidStatusTransitionError) {
    res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });
    return true;
  }
  if (err instanceof InvalidFileForAttachmentError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof AssigneeNotInOrgError) {
    res.status(400).json({ error: "ASSIGNEE_NOT_IN_ORGANIZATION" });
    return true;
  }
  if (err instanceof FamilyMustUseFamilyEndpointError) {
    res.status(403).json({ error: "FAMILY_MUST_USE_FAMILY_SAFE_ENDPOINT" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/incidents",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createIncidentSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const incident = await createIncident(req.auth!.userId, orgIdParsed.data, bodyParsed.data);
      res.status(201).json({ incident });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/observations/:observationId/escalate",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = escalateObservationSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const incident = await escalateObservationToIncident(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.observationId),
        bodyParsed.data
      );
      res.status(201).json({ incident });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/incidents",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const incidents = await listIncidents(req.auth!.userId, orgIdParsed.data, {
        careRecipientId: req.query.careRecipientId as string | undefined,
        status: req.query.status as string | undefined,
      });
      res.status(200).json({ incidents });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/incidents/:incidentId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const incident = await getIncident(req.auth!.userId, orgIdParsed.data, String(req.params.incidentId));
      res.status(200).json({ incident });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

const statusUpdateSchema = z.object({
  status: z.enum(["in_progress", "resolved"]),
  resolution: z.string().trim().min(1).max(4000).optional(),
});

router.post(
  "/organizations/:organizationId/incidents/:incidentId/status",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = statusUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const incident = await updateIncidentStatus(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.incidentId),
        bodyParsed.data.status,
        bodyParsed.data.resolution
      );
      res.status(200).json({ incident });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

const assignSchema = z.object({ assignedToUserId: z.string().uuid() });

router.post(
  "/organizations/:organizationId/incidents/:incidentId/assign",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = assignSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const incident = await assignIncident(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.incidentId),
        bodyParsed.data.assignedToUserId
      );
      res.status(200).json({ incident });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/incidents/:incidentId/timeline",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = addTimelineEntrySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const entry = await addTimelineEntry(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.incidentId),
        bodyParsed.data
      );
      res.status(201).json({ entry });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/incidents/:incidentId/timeline",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const entries = await listTimelineEntries(req.auth!.userId, orgIdParsed.data, String(req.params.incidentId));
      res.status(200).json({ entries });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/incidents/:incidentId/attachments",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = addAttachmentSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const attachment = await addIncidentAttachment(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.incidentId),
        bodyParsed.data
      );
      res.status(201).json({ attachment });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/incidents/:incidentId/attachments",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const attachments = await listIncidentAttachments(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.incidentId)
      );
      res.status(200).json({ attachments });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/care-recipients/:careRecipientId/family-incidents",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const incidents = await listFamilyIncidents(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.careRecipientId)
      );
      res.status(200).json({ incidents });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

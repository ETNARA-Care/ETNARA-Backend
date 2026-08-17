import { Router, type Response } from "express";
import { z } from "zod";
import {
  createCareRecipient,
  listCareRecipients,
  getCareRecipient,
  updateCareRecipient,
  createRecipientSchema,
  updateRecipientSchema,
  RecipientNotFoundError,
} from "./careRecipients.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

const router = Router();

const uuidParam = z.string().uuid();

function handleTenantError(err: unknown, res: Response): boolean {
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" });
    return true;
  }
  if (err instanceof InvalidTenantContextError || err instanceof InvalidOrganizationIdError) {
    res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
    return true;
  }
  if (err instanceof RecipientNotFoundError) {
    res.status(404).json({ error: "RECIPIENT_NOT_FOUND" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/care-recipients",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createRecipientSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const recipient = await createCareRecipient(req.auth!.userId, orgIdParsed.data, bodyParsed.data);
      res.status(201).json({ recipient });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/care-recipients",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const recipients = await listCareRecipients(req.auth!.userId, orgIdParsed.data);
      res.status(200).json({ recipients });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/care-recipients/:recipientId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const recipientIdParsed = uuidParam.safeParse(req.params.recipientId);
    if (!orgIdParsed.success || !recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    try {
      const recipient = await getCareRecipient(
        req.auth!.userId,
        orgIdParsed.data,
        recipientIdParsed.data
      );
      res.status(200).json({ recipient });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.patch(
  "/organizations/:organizationId/care-recipients/:recipientId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const recipientIdParsed = uuidParam.safeParse(req.params.recipientId);
    if (!orgIdParsed.success || !recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    const bodyParsed = updateRecipientSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const recipient = await updateCareRecipient(
        req.auth!.userId,
        orgIdParsed.data,
        recipientIdParsed.data,
        bodyParsed.data
      );
      res.status(200).json({ recipient });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

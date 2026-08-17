import { Router, type Response } from "express";
import { z } from "zod";
import {
  resolveOrCreateFamilyConversation,
  listConversations,
  listMessages,
  sendMessage,
  sendMessageSchema,
  RecipientNotFoundError,
  ConversationNotFoundError,
  NotAuthorizedForConversationError,
  CannotWriteError,
} from "./messaging.service.js";
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
  if (err instanceof RecipientNotFoundError || err instanceof ConversationNotFoundError) {
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof NotAuthorizedForConversationError) {
    res.status(403).json({ error: "NOT_AUTHORIZED_FOR_CONVERSATION" });
    return true;
  }
  if (err instanceof CannotWriteError) {
    res.status(403).json({ error: "CANNOT_WRITE_TO_CONVERSATION" });
    return true;
  }
  return false;
}

router.get(
  "/organizations/:organizationId/conversations",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const conversations = await listConversations(req.auth!.userId, orgIdParsed.data);
      res.status(200).json({ conversations });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/care-recipients/:recipientId/conversation",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const recipientIdParsed = uuidParam.safeParse(req.params.recipientId);
    if (!orgIdParsed.success || !recipientIdParsed.success) {
      res.status(400).json({ error: "INVALID_ID" });
      return;
    }
    try {
      const conversation = await resolveOrCreateFamilyConversation(
        req.auth!.userId,
        orgIdParsed.data,
        recipientIdParsed.data
      );
      res.status(200).json({ conversation });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/conversations/:conversationId/messages",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const result = await listMessages(req.auth!.userId, orgIdParsed.data, String(req.params.conversationId), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor as string | undefined,
      });
      res.status(200).json(result);
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/conversations/:conversationId/messages",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = sendMessageSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const message = await sendMessage(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.conversationId),
        bodyParsed.data
      );
      res.status(201).json({ message });
    } catch (err) {
      if (!handleError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

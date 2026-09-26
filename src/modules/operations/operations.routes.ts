import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  escalationSchema,
  escalateOperationalAlert,
  generateOperationsAgentBriefing,
  getOperationsCenter,
  OperationsForbiddenError,
} from "./operations.service.js";

const router = Router();
const uuid = z.string().uuid();

router.get(
  "/organizations/:organizationId/operations/center",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const organization = uuid.safeParse(req.params.organizationId);
    if (!organization.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      res.json(await getOperationsCenter(req.auth!.userId, organization.data));
    } catch (error) {
      res.status(error instanceof OperationsForbiddenError ? 403 : 500).json({
        error: error instanceof OperationsForbiddenError ? error.message : "INTERNAL_ERROR",
      });
    }
  }
);

router.post(
  "/organizations/:organizationId/operations/agent/briefing",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const organization = uuid.safeParse(req.params.organizationId);
    if (!organization.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      res.status(201).json(
        await generateOperationsAgentBriefing(req.auth!.userId, organization.data)
      );
    } catch (error) {
      res.status(error instanceof OperationsForbiddenError ? 403 : 500).json({
        error: error instanceof OperationsForbiddenError ? error.message : "INTERNAL_ERROR",
      });
    }
  }
);

router.post(
  "/organizations/:organizationId/operations/escalate",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const organization = uuid.safeParse(req.params.organizationId);
    const input = escalationSchema.safeParse(req.body);
    if (!organization.success || !input.success) {
      res.status(400).json({ error: "INVALID_OPERATIONAL_ESCALATION" });
      return;
    }
    try {
      res.status(201).json(
        await escalateOperationalAlert(req.auth!.userId, organization.data, input.data)
      );
    } catch (error) {
      res.status(error instanceof OperationsForbiddenError ? 403 : 409).json({
        error: error instanceof OperationsForbiddenError ? error.message : "ALERT_NOT_ACTIVE",
      });
    }
  }
);

export default router;

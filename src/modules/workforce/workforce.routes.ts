import { Router, type Response } from "express";
import { z } from "zod";
import {
  createOrLinkWorker,
  listWorkforce,
  getWorkerProfile,
  updateMembership,
  createWorkerSchema,
  updateMembershipSchema,
  MembershipNotFoundError,
} from "./workforce.service.js";
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
    res.status(400).json({ error: "INVALID_ID" });
    return true;
  }
  if (err instanceof MembershipNotFoundError) {
    res.status(404).json({ error: "MEMBERSHIP_NOT_FOUND" });
    return true;
  }
  if (err instanceof Error && err.name === "WorkerNotFoundError") {
    res.status(404).json({ error: "WORKER_NOT_FOUND" });
    return true;
  }
  if (err instanceof Error && err.name === "MembershipAlreadyExistsError") {
    res.status(409).json({ error: "MEMBERSHIP_ALREADY_EXISTS" });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/workers",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createWorkerSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const membership = await createOrLinkWorker(req.auth!.userId, orgIdParsed.data, bodyParsed.data);
      res.status(201).json({ membership });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/workers",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const memberships = await listWorkforce(req.auth!.userId, orgIdParsed.data);
      res.status(200).json({ memberships });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/workers/:membershipId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const profile = await getWorkerProfile(req.auth!.userId, orgIdParsed.data, String(req.params.membershipId));
      res.status(200).json(profile);
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.patch(
  "/organizations/:organizationId/workers/:membershipId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = updateMembershipSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const membership = await updateMembership(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.membershipId),
        bodyParsed.data
      );
      res.status(200).json({ membership });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

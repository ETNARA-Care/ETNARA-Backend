import { Router, type Response } from "express";
import { z } from "zod";
import {
  createCredential,
  listCredentials,
  getCredential,
  updateCredential,
  createCredentialSchema,
  updateCredentialSchema,
  createPlatformVerification,
  listPlatformVerifications,
  platformVerificationSchema,
  createOrUpdateOrganizationReview,
  organizationReviewSchema,
  WorkerNotLinkedError,
  CredentialNotFoundError,
  CredentialTypeNotFoundError,
  InvalidFileOwnershipError,
} from "./credentialing.service.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import {
  OrganizationAccessDeniedError,
  InvalidOrganizationIdError,
} from "../organizationContext/organizationContext.service.js";
import {
  MembershipNotActiveError,
  InvalidTenantContextError,
  UnauthorizedPlatformAccessError,
} from "../../context/errors.js";

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
  if (err instanceof WorkerNotLinkedError || err instanceof CredentialNotFoundError) {
    // Same 404 for "not linked" and "not found" -- no enumeration signal
    // about whether a worker/credential exists outside the actor's reach.
    res.status(404).json({ error: "NOT_FOUND" });
    return true;
  }
  if (err instanceof CredentialTypeNotFoundError) {
    res.status(400).json({ error: "INVALID_CREDENTIAL_TYPE" });
    return true;
  }
  if (err instanceof InvalidFileOwnershipError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

router.post(
  "/organizations/:organizationId/workers/:workerId/credentials",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = createCredentialSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const credential = await createCredential(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.workerId),
        bodyParsed.data
      );
      res.status(201).json({ credential });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/workers/:workerId/credentials",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const credentials = await listCredentials(req.auth!.userId, orgIdParsed.data, String(req.params.workerId));
      res.status(200).json({ credentials });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const credential = await getCredential(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.workerId),
        String(req.params.credentialId)
      );
      res.status(200).json({ credential });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.patch(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = updateCredentialSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const credential = await updateCredential(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.workerId),
        String(req.params.credentialId),
        bodyParsed.data
      );
      res.status(200).json({ credential });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// ===================== Platform Verification (platform admin only) =====================

router.post(
  "/platform/credentials/:credentialId/verifications",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const bodyParsed = platformVerificationSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const verification = await createPlatformVerification(
        req.auth!.userId,
        String(req.params.credentialId),
        bodyParsed.data
      );
      res.status(201).json({ verification });
    } catch (err) {
      if (err instanceof UnauthorizedPlatformAccessError) {
        res.status(403).json({ error: "PLATFORM_ACCESS_DENIED" });
        return;
      }
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/platform/credentials/:credentialId/verifications",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const verifications = await listPlatformVerifications(req.auth!.userId, String(req.params.credentialId));
      res.status(200).json({ verifications });
    } catch (err) {
      if (err instanceof UnauthorizedPlatformAccessError) {
        res.status(403).json({ error: "PLATFORM_ACCESS_DENIED" });
        return;
      }
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

// ===================== Organization Credential Review =====================

router.post(
  "/organizations/:organizationId/workers/:membershipId/credentials/:credentialId/review",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    const bodyParsed = organizationReviewSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const review = await createOrUpdateOrganizationReview(
        req.auth!.userId,
        orgIdParsed.data,
        String(req.params.membershipId),
        String(req.params.credentialId),
        bodyParsed.data
      );
      res.status(200).json({ review });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

export default router;

import express, { Router, type Response } from "express";
import { z } from "zod";
import {
  createCredential,
  listCredentials,
  listMyCredentialSummaries,
  listCredentialTypes,
  initiateCredentialDocumentUpload,
  completeCredentialDocumentUpload,
  listCredentialDocumentVersions,
  createCredentialDocumentDownload,
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
  CredentialAccessDeniedError,
  CredentialNotFoundError,
  CredentialTypeNotFoundError,
  InvalidFileOwnershipError,
  CredentialManagementForbiddenError,
  CredentialUploadMismatchError,
  CredentialDocumentRequiredError,
  initiateCredentialDocumentUploadSchema,
  credentialDocumentContentTypeSchema,
  uploadCredentialDocumentContent,
} from "./credentialing.service.js";
import { StorageNotConfiguredError } from "../storage/objectStorage.js";
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
import { env } from "../../config/env.js";

const router = Router();
const uuidParam = z.string().uuid();

function logUnexpectedCredentialStorageError(operation: string, err: unknown): void {
  const technical = err && typeof err === "object"
    ? err as { name?: unknown; code?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } }
    : {};
  console.error("Unexpected credential storage failure", {
    operation,
    errorName: typeof technical.name === "string" ? technical.name : "UnknownError",
    errorCode: typeof technical.code === "string"
      ? technical.code
      : typeof technical.Code === "string" ? technical.Code : undefined,
    httpStatusCode: typeof technical.$metadata?.httpStatusCode === "number"
      ? technical.$metadata.httpStatusCode
      : undefined,
  });
}

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
  if (err instanceof CredentialAccessDeniedError) {
    res.status(403).json({ error: "CREDENTIAL_ACCESS_DENIED" });
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
  if (err instanceof CredentialManagementForbiddenError) {
    res.status(403).json({ error: "CREDENTIAL_MANAGEMENT_FORBIDDEN" });
    return true;
  }
  if (err instanceof CredentialUploadMismatchError) {
    res.status(400).json({ error: "CREDENTIAL_UPLOAD_MISMATCH" });
    return true;
  }
  if (err instanceof CredentialDocumentRequiredError) {
    res.status(400).json({ error: "CREDENTIAL_DOCUMENT_REQUIRED" });
    return true;
  }
  if (err instanceof StorageNotConfiguredError) {
    res.status(503).json({ error: "STORAGE_NOT_CONFIGURED" });
    return true;
  }
  return false;
}

router.get(
  "/organizations/:organizationId/credential-types",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const credentialTypes = await listCredentialTypes(req.auth!.userId, orgIdParsed.data);
      res.status(200).json({ credentialTypes });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.get(
  "/organizations/:organizationId/me/credentials",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const credentials = await listMyCredentialSummaries(req.auth!.userId, orgIdParsed.data);
      res.status(200).json({ credentials });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

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

router.post(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId/documents/upload-url",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const bodyParsed = initiateCredentialDocumentUploadSchema.safeParse(req.body);
    if (!orgIdParsed.success || !bodyParsed.success) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const upload = await initiateCredentialDocumentUpload(
        req.auth!.userId, orgIdParsed.data, String(req.params.workerId),
        String(req.params.credentialId), bodyParsed.data
      );
      res.status(201).json({ upload });
    } catch (err) {
      if (!handleTenantError(err, res)) {
        logUnexpectedCredentialStorageError("initiateCredentialDocumentUpload", err);
        res.status(500).json({ error: "INTERNAL_ERROR" });
      }
    }
  }
);

router.post(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId/documents/:fileId/content",
  requireAuth,
  express.raw({
    type: ["application/pdf", "image/jpeg", "image/png"],
    limit: env.STORAGE_MAX_FILE_BYTES,
  }),
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    const contentTypeParsed = credentialDocumentContentTypeSchema.safeParse(req.headers["content-type"]);
    if (!orgIdParsed.success || !contentTypeParsed.success || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "INVALID_PAYLOAD" });
      return;
    }
    try {
      const upload = await uploadCredentialDocumentContent(
        req.auth!.userId, orgIdParsed.data, String(req.params.workerId),
        String(req.params.credentialId), String(req.params.fileId),
        contentTypeParsed.data, req.body
      );
      res.status(200).json({ upload });
    } catch (err) {
      if (!handleTenantError(err, res)) {
        logUnexpectedCredentialStorageError("uploadCredentialDocumentContent", err);
        res.status(500).json({ error: "INTERNAL_ERROR" });
      }
    }
  }
);

router.post(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId/documents/:fileId/complete",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const document = await completeCredentialDocumentUpload(
        req.auth!.userId, orgIdParsed.data, String(req.params.workerId),
        String(req.params.credentialId), String(req.params.fileId)
      );
      res.status(200).json({ document });
    } catch (err) {
      if (!handleTenantError(err, res)) {
        logUnexpectedCredentialStorageError("completeCredentialDocumentUpload", err);
        res.status(500).json({ error: "INTERNAL_ERROR" });
      }
    }
  }
);

router.get(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId/documents",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const documents = await listCredentialDocumentVersions(
        req.auth!.userId, orgIdParsed.data, String(req.params.workerId), String(req.params.credentialId)
      );
      res.status(200).json({ documents });
    } catch (err) {
      if (!handleTenantError(err, res)) res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  }
);

router.post(
  "/organizations/:organizationId/workers/:workerId/credentials/:credentialId/documents/:fileId/download-url",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const orgIdParsed = uuidParam.safeParse(req.params.organizationId);
    if (!orgIdParsed.success) {
      res.status(400).json({ error: "INVALID_ORGANIZATION_ID" });
      return;
    }
    try {
      const download = await createCredentialDocumentDownload(
        req.auth!.userId, orgIdParsed.data, String(req.params.workerId),
        String(req.params.credentialId), String(req.params.fileId)
      );
      res.status(200).json({ download });
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

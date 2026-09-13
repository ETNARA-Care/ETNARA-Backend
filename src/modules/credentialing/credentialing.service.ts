import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext, withPlatformContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, UnauthorizedPlatformAccessError } from "../../context/errors.js";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { createPrivateDownloadUrl, createPrivateUploadUrl, inspectPrivateObject, uploadPrivateObject } from "../storage/objectStorage.js";

export class WorkerNotLinkedError extends Error {
  constructor() {
    super("WORKER_NOT_LINKED_TO_ORGANIZATION");
    this.name = "WorkerNotLinkedError";
  }
}
export class CredentialAccessDeniedError extends Error {
  constructor() {
    super("CREDENTIAL_ACCESS_DENIED");
    this.name = "CredentialAccessDeniedError";
  }
}
export class CredentialNotFoundError extends Error {
  constructor() {
    super("CREDENTIAL_NOT_FOUND");
    this.name = "CredentialNotFoundError";
  }
}
export class CredentialTypeNotFoundError extends Error {
  constructor() {
    super("CREDENTIAL_TYPE_NOT_FOUND");
    this.name = "CredentialTypeNotFoundError";
  }
}
export class InvalidFileOwnershipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidFileOwnershipError";
  }
}
export class CredentialManagementForbiddenError extends Error {
  constructor() {
    super("CREDENTIAL_MANAGEMENT_FORBIDDEN");
    this.name = "CredentialManagementForbiddenError";
  }
}
export class CredentialUploadMismatchError extends Error {
  constructor() {
    super("CREDENTIAL_UPLOAD_MISMATCH");
    this.name = "CredentialUploadMismatchError";
  }
}
export class CredentialDocumentRequiredError extends Error {
  constructor() {
    super("CREDENTIAL_DOCUMENT_REQUIRED");
    this.name = "CredentialDocumentRequiredError";
  }
}

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const createCredentialSchema = z
  .object({
    credentialTypeCode: z.string().min(1), // resolved to credential_type_id by code, never hardcoded
    issuingEntityName: z.string().optional(),
    issuingEntityType: z.enum(["government", "external_provider", "platform"]),
    issuedAt: z.string().date().optional(),
    expiresAt: z.string().date().optional(),
    fileId: z.string().uuid().optional(),
  })
  .refine((d) => !d.issuedAt || !d.expiresAt || d.expiresAt >= d.issuedAt, {
    message: "expiresAt must be on or after issuedAt",
    path: ["expiresAt"],
  });
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

const updateCredentialSchema = z
  .object({
    issuingEntityName: z.string(),
    issuingEntityType: z.enum(["government", "external_provider", "platform"]),
    issuedAt: z.string().date().nullable(),
    expiresAt: z.string().date().nullable(),
    status: z.enum(["active", "expired", "revoked"]),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field required" })
  .refine((d) => !d.issuedAt || !d.expiresAt || d.expiresAt >= d.issuedAt, {
    message: "expiresAt must be on or after issuedAt",
    path: ["expiresAt"],
  });
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export { updateCredentialSchema };

const supportedCredentialContentTypes = ["application/pdf", "image/jpeg", "image/png"] as const;
export const credentialDocumentContentTypeSchema = z.enum(supportedCredentialContentTypes);
export const initiateCredentialDocumentUploadSchema = z.object({
  originalFilename: z.string().trim().min(1).max(180),
  contentType: z.enum(supportedCredentialContentTypes),
  sizeBytes: z.number().int().positive().max(env.STORAGE_MAX_FILE_BYTES),
});
export type InitiateCredentialDocumentUploadInput = z.infer<typeof initiateCredentialDocumentUploadSchema>;

interface CredentialRow {
  id: string;
  worker_id: string;
  credential_type_id: string;
  document_id: string | null;
  issuing_entity_name: string | null;
  issuing_entity_type: string;
  issued_at: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MyCredentialSummary {
  id: string;
  typeCode: string;
  typeName: string;
  status: string;
  expiresAt: string | null;
  verificationStatus: "verified" | "pending" | "rejected";
}

export interface CredentialTypeCatalogItem {
  code: string;
  name: string;
}

export async function listCredentialTypes(
  userId: string,
  organizationId: string
): Promise<CredentialTypeCatalogItem[]> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<CredentialTypeCatalogItem>`
      SELECT code, name
      FROM credential_types
      ORDER BY name
    `.execute(trx);
    return result.rows;
  });
}

/**
 * Confirms the actor's organization has a real, active reason to touch this
 * worker's credentials: an active organization_worker_membership. This is
 * enforced both here (clean 403/404) AND independently by credentials' own
 * RLS policy (last line of defense) -- neither one alone is trusted.
 */
async function assertWorkerLinkedToOrg(trx: unknown, organizationId: string, workerId: string) {
  const result = await sql<{ id: string }>`
    SELECT id FROM organization_worker_memberships
    WHERE worker_id = ${workerId} AND organization_id = ${organizationId} AND status = 'active'
    LIMIT 1
  `.execute(trx as never);
  if (!result.rows[0]) throw new WorkerNotLinkedError();

  const actor = await sql<{ allowed: boolean }>`
    SELECT (
      app_is_org_manager()
      OR app_is_superadmin()
      OR EXISTS (
        SELECT 1 FROM workers w
        WHERE w.id = ${workerId}
          AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      )
    ) AS allowed
  `.execute(trx as never);
  if (!actor.rows[0]?.allowed) throw new CredentialAccessDeniedError();
}

async function assertCredentialManager(trx: unknown) {
  const result = await sql<{ allowed: boolean }>`SELECT (app_is_org_manager() OR app_is_superadmin()) AS allowed`.execute(trx as never);
  if (!result.rows[0]?.allowed) throw new CredentialManagementForbiddenError();
}

async function assertCredentialBelongsToWorker(trx: unknown, workerId: string, credentialId: string) {
  const result = await sql<{ id: string; credential_type_id: string; document_id: string | null }>`
    SELECT id, credential_type_id, document_id FROM credentials
    WHERE id = ${credentialId} AND worker_id = ${workerId}
    LIMIT 1
  `.execute(trx as never);
  if (!result.rows[0]) throw new CredentialNotFoundError();
  return result.rows[0];
}

async function resolveCredentialTypeId(trx: unknown, code: string): Promise<string> {
  const result = await sql<{ id: string }>`
    SELECT id FROM credential_types WHERE code = ${code} LIMIT 1
  `.execute(trx as never);
  if (!result.rows[0]) throw new CredentialTypeNotFoundError();
  return result.rows[0].id;
}

export async function createCredential(
  userId: string,
  organizationId: string,
  workerId: string,
  input: CreateCredentialInput
): Promise<CredentialRow> {
  assertUuid(workerId, "workerId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const credentialTypeId = await resolveCredentialTypeId(trx, input.credentialTypeCode);

    let documentId: string | null = null;
    if (input.fileId) {
      // Must be a PLATFORM_PROFESSIONAL file owned by exactly this worker --
      // never an ORGANIZATION_OPERATIONAL file, never another worker's file.
      const fileCheck = await sql<{ id: string; scope_type: string; owner_worker_id: string | null }>`
        SELECT id, scope_type, owner_worker_id FROM stored_files WHERE id = ${input.fileId} LIMIT 1
      `.execute(trx);
      const file = fileCheck.rows[0];
      if (!file) throw new InvalidFileOwnershipError("FILE_NOT_FOUND");
      if (file.scope_type !== "PLATFORM_PROFESSIONAL") {
        throw new InvalidFileOwnershipError("FILE_MUST_BE_PLATFORM_PROFESSIONAL");
      }
      if (file.owner_worker_id !== workerId) {
        throw new InvalidFileOwnershipError("FILE_OWNER_MISMATCH");
      }
      const doc = await sql<{ id: string }>`
        INSERT INTO documents (worker_id, credential_type_id, file_id, status)
        VALUES (${workerId}, ${credentialTypeId}, ${input.fileId}, 'presented')
        RETURNING id
      `.execute(trx);
      documentId = doc.rows[0].id;
      await sql`
        INSERT INTO document_versions (document_id, file_id, version)
        VALUES (${documentId}, ${input.fileId}, 1)
      `.execute(trx);
    }

    const result = await sql<CredentialRow>`
      INSERT INTO credentials (
        worker_id, credential_type_id, document_id, issuing_entity_name,
        issuing_entity_type, issued_at, expires_at
      ) VALUES (
        ${workerId}, ${credentialTypeId}, ${documentId}, ${input.issuingEntityName ?? null},
        ${input.issuingEntityType}, ${input.issuedAt ?? null}, ${input.expiresAt ?? null}
      )
      RETURNING id, worker_id, credential_type_id, document_id, issuing_entity_name,
                issuing_entity_type, issued_at, expires_at, status, created_at, updated_at
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listCredentials(userId: string, organizationId: string, workerId: string) {
  assertUuid(workerId, "workerId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const result = await sql<CredentialRow & { type_code: string; document_status: string | null; organization_review_status: string | null; organization_review_notes: string | null }>`
      SELECT c.id, c.worker_id, c.credential_type_id, c.document_id, c.issuing_entity_name,
             c.issuing_entity_type, c.issued_at, c.expires_at, c.status, c.created_at, c.updated_at,
             ct.code as type_code, d.status AS document_status,
             ocr.review_status AS organization_review_status, ocr.notes AS organization_review_notes
      FROM credentials c
      JOIN credential_types ct ON ct.id = c.credential_type_id
      LEFT JOIN documents d ON d.id = c.document_id
      LEFT JOIN organization_credential_reviews ocr
        ON ocr.credential_id = c.id AND ocr.organization_id = ${organizationId}
      WHERE c.worker_id = ${workerId}
      ORDER BY ct.code
    `.execute(trx);
    await sql`SELECT app_notify_credential_expiry_managers(${workerId})`.execute(trx);
    return result.rows;
  });
}

export async function initiateCredentialDocumentUpload(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  input: InitiateCredentialDocumentUploadInput
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertCredentialManager(trx);
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    await assertCredentialBelongsToWorker(trx, workerId, credentialId);
    const fileId = randomUUID();
    const storageKey = `credentials/${workerId}/${credentialId}/${fileId}`;
    const result = await sql<{ id: string }>`
      INSERT INTO stored_files (
        id, scope_type, owner_worker_id, storage_key, content_type,
        original_filename, size_bytes, uploaded_by_user_id, visibility, status
      ) VALUES (
        ${fileId}, 'PLATFORM_PROFESSIONAL', ${workerId}, ${storageKey}, ${input.contentType},
        ${input.originalFilename}, ${input.sizeBytes}, ${userId}, 'private', 'hidden'
      ) RETURNING id
    `.execute(trx);
    const uploadUrl = await createPrivateUploadUrl(storageKey, input.contentType);
    return { fileId: result.rows[0].id, uploadUrl, expiresInSeconds: 300 };
  });
}

export async function uploadCredentialDocumentContent(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  fileId: string,
  contentType: z.infer<typeof credentialDocumentContentTypeSchema>,
  body: Buffer
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  assertUuid(fileId, "fileId");
  if (body.byteLength === 0 || body.byteLength > env.STORAGE_MAX_FILE_BYTES) {
    throw new CredentialUploadMismatchError();
  }

  const file = await withTenantContext({ userId, organizationId }, async (trx) => {
    await assertCredentialManager(trx);
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    await assertCredentialBelongsToWorker(trx, workerId, credentialId);
    const result = await sql<{ storage_key: string; content_type: string; size_bytes: string }>`
      SELECT storage_key, content_type, size_bytes
      FROM stored_files
      WHERE id = ${fileId} AND owner_worker_id = ${workerId}
        AND scope_type = 'PLATFORM_PROFESSIONAL' AND status = 'hidden'
      LIMIT 1
    `.execute(trx);
    return result.rows[0];
  });

  if (!file) throw new InvalidFileOwnershipError("FILE_NOT_FOUND");
  if (!file.storage_key.startsWith(`credentials/${workerId}/${credentialId}/`)) {
    throw new InvalidFileOwnershipError("FILE_OWNER_MISMATCH");
  }
  if (file.content_type !== contentType || Number(file.size_bytes) !== body.byteLength) {
    throw new CredentialUploadMismatchError();
  }

  await uploadPrivateObject(file.storage_key, contentType, body);
  return { fileId };
}

export async function completeCredentialDocumentUpload(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  fileId: string
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  assertUuid(fileId, "fileId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertCredentialManager(trx);
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const credential = await assertCredentialBelongsToWorker(trx, workerId, credentialId);
    const fileResult = await sql<{ id: string; storage_key: string; content_type: string; original_filename: string; size_bytes: string }>`
      SELECT id, storage_key, content_type, original_filename, size_bytes
      FROM stored_files
      WHERE id = ${fileId} AND owner_worker_id = ${workerId}
        AND scope_type = 'PLATFORM_PROFESSIONAL' AND status = 'hidden'
      LIMIT 1
    `.execute(trx);
    const file = fileResult.rows[0];
    if (!file) throw new InvalidFileOwnershipError("FILE_NOT_FOUND");
    if (!file.storage_key.startsWith(`credentials/${workerId}/${credentialId}/`)) throw new InvalidFileOwnershipError("FILE_OWNER_MISMATCH");
    const object = await inspectPrivateObject(file.storage_key);
    if (object.sizeBytes !== Number(file.size_bytes) || object.contentType !== file.content_type) {
      throw new CredentialUploadMismatchError();
    }

    let documentId = credential.document_id;
    let version = 1;
    if (!documentId) {
      const documentResult = await sql<{ id: string }>`
        INSERT INTO documents (worker_id, credential_type_id, file_id, status)
        VALUES (${workerId}, ${credential.credential_type_id}, ${fileId}, 'presented')
        RETURNING id
      `.execute(trx);
      documentId = documentResult.rows[0].id;
      await sql`UPDATE credentials SET document_id = ${documentId}, updated_at = now() WHERE id = ${credentialId}`.execute(trx);
    } else {
      const versionResult = await sql<{ next_version: number }>`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM document_versions WHERE document_id = ${documentId}
      `.execute(trx);
      version = Number(versionResult.rows[0].next_version);
      await sql`UPDATE documents SET file_id = ${fileId}, status = 'presented', updated_at = now() WHERE id = ${documentId}`.execute(trx);
    }
    await sql`
      INSERT INTO document_versions (document_id, file_id, version)
      VALUES (${documentId}, ${fileId}, ${version})
    `.execute(trx);
    await sql`UPDATE stored_files SET status = 'active' WHERE id = ${fileId}`.execute(trx);
    await sql`
      UPDATE organization_credential_reviews
      SET review_status = 'pending', notes = NULL, reviewed_at = NULL
      WHERE credential_id = ${credentialId} AND organization_id = ${organizationId}
    `.execute(trx);
    return { documentId, fileId, version, status: "presented" as const };
  });
}

export async function listCredentialDocumentVersions(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const credential = await assertCredentialBelongsToWorker(trx, workerId, credentialId);
    if (!credential.document_id) return [];
    const result = await sql<{
      file_id: string; version: number; original_filename: string; content_type: string;
      size_bytes: string; created_at: string; is_current: boolean;
      review_status: string | null; review_notes: string | null; reviewed_at: string | null;
    }>`
      SELECT dv.file_id, dv.version, sf.original_filename, sf.content_type,
             sf.size_bytes, dv.created_at, (d.file_id = dv.file_id) AS is_current,
             review.review_status, review.notes AS review_notes, review.reviewed_at
      FROM document_versions dv
      JOIN documents d ON d.id = dv.document_id
      JOIN stored_files sf ON sf.id = dv.file_id
      LEFT JOIN LATERAL (
        SELECT odvr.review_status, odvr.notes, odvr.reviewed_at
        FROM organization_document_version_reviews odvr
        WHERE odvr.organization_id = ${organizationId} AND odvr.file_id = dv.file_id
        ORDER BY odvr.reviewed_at DESC LIMIT 1
      ) review ON true
      WHERE dv.document_id = ${credential.document_id} AND sf.status = 'active'
      ORDER BY dv.version DESC
    `.execute(trx);
    return result.rows;
  });
}

export async function createCredentialDocumentDownload(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  fileId: string
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  assertUuid(fileId, "fileId");
  const file = await withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const credential = await assertCredentialBelongsToWorker(trx, workerId, credentialId);
    if (!credential.document_id) throw new CredentialNotFoundError();
    const result = await sql<{ storage_key: string; original_filename: string; content_type: string }>`
      SELECT sf.storage_key, sf.original_filename, sf.content_type
      FROM document_versions dv
      JOIN stored_files sf ON sf.id = dv.file_id
      WHERE dv.document_id = ${credential.document_id} AND dv.file_id = ${fileId} AND sf.status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new InvalidFileOwnershipError("FILE_NOT_FOUND");
    return result.rows[0];
  });
  const downloadUrl = await createPrivateDownloadUrl(file.storage_key, file.original_filename, file.content_type);
  return { downloadUrl, expiresInSeconds: 300 };
}

/**
 * Caregiver self-service summary. The worker identity is resolved from the
 * authenticated user rather than accepted from the client, and document/file
 * identifiers are deliberately excluded from the response.
 */
export async function listMyCredentialSummaries(
  userId: string,
  organizationId: string
): Promise<MyCredentialSummary[]> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const worker = await sql<{ id: string }>`
      SELECT w.id
      FROM workers w
      JOIN organization_worker_memberships owm ON owm.worker_id = w.id
      WHERE w.user_id = ${userId}
        AND owm.organization_id = ${organizationId}
        AND owm.status = 'active'
      LIMIT 1
    `.execute(trx);
    if (!worker.rows[0]) throw new WorkerNotLinkedError();

    const result = await sql<{
      id: string;
      type_code: string;
      type_name: string;
      status: string;
      expires_at: string | null;
      verification_status: "verified" | "pending" | "rejected";
    }>`
      SELECT c.id, ct.code AS type_code, ct.name AS type_name,
             CASE
               WHEN c.status = 'active' AND c.expires_at IS NOT NULL AND c.expires_at < current_date THEN 'expired'
               ELSE c.status::text
             END AS status,
             c.expires_at,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM credential_platform_verifications cpv
                 WHERE cpv.credential_id = c.id AND cpv.status = 'verified'
               ) OR EXISTS (
                 SELECT 1 FROM organization_credential_reviews ocr
                 WHERE ocr.credential_id = c.id
                   AND ocr.organization_id = ${organizationId}
                   AND ocr.review_status = 'approved'
               ) THEN 'verified'
               WHEN EXISTS (
                 SELECT 1 FROM credential_platform_verifications cpv
                 WHERE cpv.credential_id = c.id AND cpv.status = 'rejected'
               ) OR EXISTS (
                 SELECT 1 FROM organization_credential_reviews ocr
                 WHERE ocr.credential_id = c.id
                   AND ocr.organization_id = ${organizationId}
                   AND ocr.review_status = 'rejected'
               ) THEN 'rejected'
               ELSE 'pending'
             END AS verification_status
      FROM credentials c
      JOIN credential_types ct ON ct.id = c.credential_type_id
      WHERE c.worker_id = ${worker.rows[0].id}
        AND c.status <> 'revoked'
      ORDER BY ct.name
    `.execute(trx);

    return result.rows.map((row) => ({
      id: row.id,
      typeCode: row.type_code,
      typeName: row.type_name,
      status: row.status,
      expiresAt: row.expires_at,
      verificationStatus: row.verification_status,
    }));
  });
}

export async function getCredential(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string
) {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);
    const result = await sql<CredentialRow>`
      SELECT id, worker_id, credential_type_id, document_id, issuing_entity_name,
             issuing_entity_type, issued_at, expires_at, status, created_at, updated_at
      FROM credentials
      WHERE id = ${credentialId} AND worker_id = ${workerId}
      LIMIT 1
    `.execute(trx);
    if (!result.rows[0]) throw new CredentialNotFoundError();
    return result.rows[0];
  });
}

export async function updateCredential(
  userId: string,
  organizationId: string,
  workerId: string,
  credentialId: string,
  input: UpdateCredentialInput
): Promise<CredentialRow> {
  assertUuid(workerId, "workerId");
  assertUuid(credentialId, "credentialId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertWorkerLinkedToOrg(trx, organizationId, workerId);

    // worker_id is deliberately NEVER part of the whitelist below -- a
    // credential can never be reassigned from one worker to another via
    // this (or any) update path.
    const fragments = [];
    if (input.issuingEntityName !== undefined) fragments.push(sql`issuing_entity_name = ${input.issuingEntityName}`);
    if (input.issuingEntityType !== undefined) fragments.push(sql`issuing_entity_type = ${input.issuingEntityType}`);
    if (input.issuedAt !== undefined) fragments.push(sql`issued_at = ${input.issuedAt}`);
    if (input.expiresAt !== undefined) fragments.push(sql`expires_at = ${input.expiresAt}`);
    if (input.status !== undefined) fragments.push(sql`status = ${input.status}`);
    fragments.push(sql`updated_at = now()`);

    const result = await sql<CredentialRow>`
      UPDATE credentials
      SET ${sql.join(fragments, sql`, `)}
      WHERE id = ${credentialId} AND worker_id = ${workerId}
      RETURNING id, worker_id, credential_type_id, document_id, issuing_entity_name,
                issuing_entity_type, issued_at, expires_at, status, created_at, updated_at
    `.execute(trx);
    if (!result.rows[0]) throw new CredentialNotFoundError();
    return result.rows[0];
  });
}

// ===================== Platform Verification =====================

export const platformVerificationSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  notes: z.string().optional(),
});
export type PlatformVerificationInput = z.infer<typeof platformVerificationSchema>;

/**
 * ONLY callable through withPlatformContext(), which itself re-verifies
 * platform_admins before opening any transaction. No organization, worker,
 * or frontend-controlled flag can reach this path.
 */
export async function createPlatformVerification(
  actingUserId: string,
  credentialId: string,
  input: PlatformVerificationInput
) {
  assertUuid(credentialId, "credentialId");
  return withPlatformContext(actingUserId, async (trx) => {
    const credCheck = await sql<{ id: string }>`SELECT id FROM credentials WHERE id = ${credentialId} LIMIT 1`.execute(
      trx
    );
    if (!credCheck.rows[0]) throw new CredentialNotFoundError();

    const result = await sql<{
      id: string;
      credential_id: string;
      verified_by_user_id: string;
      verified_at: string;
      status: string;
      notes: string | null;
    }>`
      INSERT INTO credential_platform_verifications (credential_id, verified_by_user_id, status, notes)
      VALUES (${credentialId}, ${actingUserId}, ${input.status}, ${input.notes ?? null})
      RETURNING id, credential_id, verified_by_user_id, verified_at, status, notes
    `.execute(trx);
    return result.rows[0];
  });
}

export async function listPlatformVerifications(actingUserId: string, credentialId: string) {
  assertUuid(credentialId, "credentialId");
  return withPlatformContext(actingUserId, async (trx) => {
    const result = await sql<{ id: string; status: string; verified_at: string; notes: string | null }>`
      SELECT id, status, verified_at, notes FROM credential_platform_verifications
      WHERE credential_id = ${credentialId}
      ORDER BY verified_at DESC
    `.execute(trx);
    return result.rows;
  });
}

// ===================== Organization Credential Review =====================

export const organizationReviewSchema = z.object({
  reviewStatus: z.enum(["pending", "approved", "rejected"]),
  notes: z.string().trim().max(2000).optional(),
}).superRefine((input, context) => {
  if (input.reviewStatus === "rejected" && !input.notes) {
    context.addIssue({ code: "custom", path: ["notes"], message: "notes are required when rejecting a document" });
  }
});
export type OrganizationReviewInput = z.infer<typeof organizationReviewSchema>;

export async function createOrUpdateOrganizationReview(
  userId: string,
  organizationId: string,
  membershipId: string,
  credentialId: string,
  input: OrganizationReviewInput
) {
  assertUuid(membershipId, "organizationWorkerMembershipId");
  assertUuid(credentialId, "credentialId");
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await assertCredentialManager(trx);
    const membershipRow = await sql<{ worker_id: string }>`
      SELECT worker_id FROM organization_worker_memberships
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!membershipRow.rows[0]) throw new WorkerNotLinkedError();

    const credCheck = await sql<{ id: string; document_id: string | null; file_id: string | null }>`
      SELECT c.id, c.document_id, d.file_id
      FROM credentials c LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.id = ${credentialId} AND c.worker_id = ${membershipRow.rows[0].worker_id} LIMIT 1
    `.execute(trx);
    if (!credCheck.rows[0]) throw new CredentialNotFoundError();
    if (!credCheck.rows[0].document_id) throw new CredentialDocumentRequiredError();

    await sql`
      UPDATE documents
      SET status = ${input.reviewStatus === "approved" ? "verified" : input.reviewStatus === "rejected" ? "rejected" : "presented"},
          updated_at = now()
      WHERE id = (SELECT document_id FROM credentials WHERE id = ${credentialId})
    `.execute(trx);

    await sql`
      INSERT INTO organization_document_version_reviews (
        organization_id, credential_id, document_id, file_id,
        review_status, notes, reviewed_by_user_id
      ) VALUES (
        ${organizationId}, ${credentialId}, ${credCheck.rows[0].document_id}, ${credCheck.rows[0].file_id},
        ${input.reviewStatus}, ${input.notes ?? null}, ${userId}
      )
    `.execute(trx);

    const existing = await sql<{ id: string }>`
      SELECT id FROM organization_credential_reviews
      WHERE credential_id = ${credentialId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);

    if (existing.rows[0]) {
      const result = await sql<{
        id: string;
        credential_id: string;
        organization_id: string;
        review_status: string;
        notes: string | null;
        reviewed_at: string | null;
      }>`
        UPDATE organization_credential_reviews
        SET review_status = ${input.reviewStatus}, notes = ${input.notes ?? null},
            reviewed_by_user_id = ${userId}, reviewed_at = now()
        WHERE id = ${existing.rows[0].id}
        RETURNING id, credential_id, organization_id, review_status, notes, reviewed_at
      `.execute(trx);
      return result.rows[0];
    }

    const result = await sql<{
      id: string;
      credential_id: string;
      organization_id: string;
      review_status: string;
      notes: string | null;
      reviewed_at: string | null;
    }>`
      INSERT INTO organization_credential_reviews (
        credential_id, organization_id, reviewed_by_user_id, review_status, notes, reviewed_at
      ) VALUES (
        ${credentialId}, ${organizationId}, ${userId}, ${input.reviewStatus}, ${input.notes ?? null}, now()
      )
      RETURNING id, credential_id, organization_id, review_status, notes, reviewed_at
    `.execute(trx);
    return result.rows[0];
  });
}

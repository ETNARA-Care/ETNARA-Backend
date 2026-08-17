import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext, withPlatformContext } from "../../context/tenantContext.js";
import { InvalidTenantContextError, UnauthorizedPlatformAccessError } from "../../context/errors.js";

export class WorkerNotLinkedError extends Error {
  constructor() {
    super("WORKER_NOT_LINKED_TO_ORGANIZATION");
    this.name = "WorkerNotLinkedError";
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

const uuidSchema = z.string().uuid();
function assertUuid(value: string, label: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new InvalidTenantContextError(`${label} must be a valid UUID, received: ${JSON.stringify(value)}`);
  }
}

export const createCredentialSchema = z.object({
  credentialTypeCode: z.string().min(1), // resolved to credential_type_id by code, never hardcoded
  issuingEntityName: z.string().optional(),
  issuingEntityType: z.enum(["government", "external_provider", "platform"]),
  issuedAt: z.string().date().optional(),
  expiresAt: z.string().date().optional(),
  fileId: z.string().uuid().optional(),
});
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

const updateCredentialSchema = z
  .object({
    issuingEntityName: z.string(),
    expiresAt: z.string().date().nullable(),
    status: z.enum(["active", "expired", "revoked"]),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field required" });
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export { updateCredentialSchema };

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
    const result = await sql<CredentialRow & { type_code: string }>`
      SELECT c.id, c.worker_id, c.credential_type_id, c.document_id, c.issuing_entity_name,
             c.issuing_entity_type, c.issued_at, c.expires_at, c.status, c.created_at, c.updated_at,
             ct.code as type_code
      FROM credentials c
      JOIN credential_types ct ON ct.id = c.credential_type_id
      WHERE c.worker_id = ${workerId}
      ORDER BY ct.code
    `.execute(trx);
    return result.rows;
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
  notes: z.string().optional(),
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
    const membershipRow = await sql<{ worker_id: string }>`
      SELECT worker_id FROM organization_worker_memberships
      WHERE id = ${membershipId} AND organization_id = ${organizationId}
      LIMIT 1
    `.execute(trx);
    if (!membershipRow.rows[0]) throw new WorkerNotLinkedError();

    const credCheck = await sql<{ id: string }>`
      SELECT id FROM credentials WHERE id = ${credentialId} AND worker_id = ${membershipRow.rows[0].worker_id} LIMIT 1
    `.execute(trx);
    if (!credCheck.rows[0]) throw new CredentialNotFoundError();

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

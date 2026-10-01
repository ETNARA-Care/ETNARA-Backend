import { sql } from "kysely";
import { withPlatformContext } from "../../context/tenantContext.js";

export interface PlatformOrganizationCredentialItem {
  credential_id: string;
  worker_id: string;
  worker_name: string;
  credential_type_code: string;
  credential_type_name: string;
  issuing_entity_name: string | null;
  expires_at: string | null;
  credential_status: string;
  file_id: string | null;
  original_filename: string | null;
  verification_status: "pending" | "verified" | "rejected";
  verification_notes: string | null;
}

export async function listPlatformOrganizationCredentials(userId: string, organizationId: string) {
  return withPlatformContext(userId, async (trx) => {
    const organization = await sql<{ id: string }>`
      SELECT id FROM organizations
      WHERE id = ${organizationId} AND archived_at IS NULL
      LIMIT 1
    `.execute(trx);
    if (!organization.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");

    const result = await sql<PlatformOrganizationCredentialItem>`
      SELECT DISTINCT ON (c.id)
        c.id AS credential_id,
        w.id AS worker_id,
        COALESCE(w.display_name, 'Personal sin nombre') AS worker_name,
        ct.code AS credential_type_code,
        ct.name AS credential_type_name,
        c.issuing_entity_name,
        c.expires_at,
        c.status::text AS credential_status,
        sf.id AS file_id,
        sf.original_filename,
        COALESCE(latest.status::text, 'pending') AS verification_status,
        latest.notes AS verification_notes
      FROM organization_worker_memberships owm
      JOIN workers w ON w.id = owm.worker_id
      JOIN credentials c ON c.worker_id = w.id AND c.status <> 'revoked'
      JOIN credential_types ct ON ct.id = c.credential_type_id
      LEFT JOIN documents d ON d.id = c.document_id
      LEFT JOIN stored_files sf ON sf.id = d.file_id AND sf.status = 'active'
      LEFT JOIN LATERAL (
        SELECT cpv.status, cpv.notes, cpv.verified_at
        FROM credential_platform_verifications cpv
        WHERE cpv.credential_id = c.id
          AND d.file_id IS NOT NULL
          AND cpv.file_id = d.file_id
        ORDER BY cpv.verified_at DESC
        LIMIT 1
      ) latest ON true
      WHERE owm.organization_id = ${organizationId}
        AND owm.status = 'active'
      ORDER BY c.id, w.display_name NULLS LAST, ct.name
    `.execute(trx);
    return result.rows;
  });
}

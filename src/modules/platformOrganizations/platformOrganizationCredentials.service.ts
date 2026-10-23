import { sql } from "kysely";
import { withPlatformContext } from "../../context/tenantContext.js";

/**
 * Platform privacy boundary:
 * ETNARA Administration may inspect aggregate credential/compliance status,
 * but must not receive worker identities, credential documents, filenames,
 * issuing entities, expirations tied to a worker, or review notes.
 */
export interface PlatformOrganizationCredentialSummary {
  total_active_workers: number;
  workers_with_credentials: number;
  credentials_total: number;
  credentials_pending: number;
  credentials_verified: number;
  credentials_rejected: number;
}

export async function getPlatformOrganizationCredentialSummary(userId: string, organizationId: string) {
  return withPlatformContext(userId, async (trx) => {
    const organization = await sql<{ id: string }>`
      SELECT id FROM organizations
      WHERE id = ${organizationId} AND archived_at IS NULL
      LIMIT 1
    `.execute(trx);
    if (!organization.rows[0]) throw new Error("ORGANIZATION_NOT_FOUND");

    const result = await sql<PlatformOrganizationCredentialSummary>`
      WITH org_workers AS (
        SELECT DISTINCT owm.worker_id
        FROM organization_worker_memberships owm
        WHERE owm.organization_id = ${organizationId}
          AND owm.status = 'active'
      ),
      worker_credentials AS (
        SELECT c.id, c.worker_id,
          COALESCE(latest.status::text, 'pending') AS verification_status
        FROM org_workers ow
        JOIN credentials c ON c.worker_id = ow.worker_id AND c.status <> 'revoked'
        LEFT JOIN LATERAL (
          SELECT cpv.status
          FROM credential_platform_verifications cpv
          WHERE cpv.credential_id = c.id
          ORDER BY cpv.verified_at DESC
          LIMIT 1
        ) latest ON true
      )
      SELECT
        (SELECT COUNT(*)::int FROM org_workers) AS total_active_workers,
        (SELECT COUNT(DISTINCT worker_id)::int FROM worker_credentials) AS workers_with_credentials,
        COUNT(*)::int AS credentials_total,
        COUNT(*) FILTER (WHERE verification_status = 'pending')::int AS credentials_pending,
        COUNT(*) FILTER (WHERE verification_status = 'verified')::int AS credentials_verified,
        COUNT(*) FILTER (WHERE verification_status = 'rejected')::int AS credentials_rejected
      FROM worker_credentials
    `.execute(trx);

    return result.rows[0] ?? {
      total_active_workers: 0,
      workers_with_credentials: 0,
      credentials_total: 0,
      credentials_pending: 0,
      credentials_verified: 0,
      credentials_rejected: 0,
    };
  });
}

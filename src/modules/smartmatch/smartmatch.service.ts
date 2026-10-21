import { sql } from "kysely";
import { withTenantContext } from "../../context/tenantContext.js";
import type { SmartMatchPublishInput } from "./smartmatch.schemas.js";

export class SmartMatchForbiddenError extends Error {
  constructor() { super("SMARTMATCH_FORBIDDEN"); }
}
export class SmartMatchNetworkDisabledError extends Error {
  constructor() { super("SMARTMATCH_NETWORK_DISABLED"); }
}

/** Agency-side internal opportunity metadata only; no patient information. */
export async function publishInternalOpportunity(
  userId: string, organizationId: string, input: SmartMatchPublishInput,
) {
  if (input.visibility !== "INTERNAL") throw new SmartMatchNetworkDisabledError();
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const roles = await sql<{ allowed: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.user_id = ${userId} AND om.organization_id = ${organizationId}
          AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
      ) AS allowed
    `.execute(trx);
    if (!roles.rows[0]?.allowed) throw new SmartMatchForbiddenError();
    const inserted = await sql<{
      id: string; region_label: string; role_label: string;
      starts_at: string; ends_at: string; status: string;
    }>`
      INSERT INTO smartmatch_opportunities (
        organization_id, created_by_user_id, visibility, status,
        region_label, role_label, starts_at, ends_at
      ) VALUES (
        ${organizationId}, ${userId}, 'INTERNAL', 'DRAFT',
        ${input.regionLabel}, ${input.roleLabel},
        ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz
      )
      RETURNING id, region_label, role_label, starts_at, ends_at, status
    `.execute(trx);
    return inserted.rows[0];
  });
}

export async function listAgencyOpportunities(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const rows = await sql<{
      id: string; region_label: string; role_label: string;
      starts_at: string; ends_at: string; status: string;
    }>`
      SELECT id, region_label, role_label, starts_at, ends_at, status
      FROM smartmatch_opportunities
      WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC LIMIT 100
    `.execute(trx);
    return rows.rows;
  });
}

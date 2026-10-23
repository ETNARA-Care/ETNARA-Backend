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
    await requireSmartMatchAgencyAdmin(trx, userId, organizationId);
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

/**
 * Publish a vetted INTERNAL draft. Any active administrator of the same
 * agency may publish it (not only its creator); RLS and the 097 transition
 * trigger keep it within the agency and allow only DRAFT -> PUBLISHED.
 * No cross-organization discovery.
 */
export async function activateInternalOpportunity(
  userId: string, organizationId: string, opportunityId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireSmartMatchAgencyAdmin(trx, userId, organizationId);
    const updated = await sql<{ id: string; status: string }>`
      UPDATE smartmatch_opportunities
      SET status = 'PUBLISHED', updated_at = now()
      WHERE id = ${opportunityId}
        AND organization_id = ${organizationId}
        AND visibility = 'INTERNAL'
        AND status = 'DRAFT'
        AND starts_at > now()
      RETURNING id, status
    `.execute(trx);
    return updated.rows[0] ?? null;
  });
}

async function requireSmartMatchAgencyAdmin(
  trx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  userId: string,
  organizationId: string,
): Promise<void> {
  const result = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM organization_memberships om
      JOIN user_roles ur ON ur.organization_membership_id = om.id
      JOIN roles r ON r.id = ur.role_id
      WHERE om.user_id = ${userId}
        AND om.organization_id = ${organizationId}
        AND om.status = 'active'
        AND r.code = 'ORGANIZATION_ADMIN'
    ) AS allowed
  `.execute(trx);
  if (!result.rows[0]?.allowed) throw new SmartMatchForbiddenError();
}

/**
 * Read-only aggregate for agency administrators. Never returns caregiver
 * identities, patient details or applications from another organization.
 * Submission and approval are intentionally not enabled.
 */
export async function listAgencyApplicationCounts(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireSmartMatchAgencyAdmin(trx, userId, organizationId);
    const result = await sql<{
      opportunity_id: string; pending_count: number;
    }>`
      SELECT a.opportunity_id, count(*)::integer AS pending_count
      FROM smartmatch_applications a
      JOIN smartmatch_opportunities o ON o.id = a.opportunity_id
      WHERE o.organization_id = ${organizationId}
        AND o.visibility = 'INTERNAL'
        AND a.status = 'PENDING'
      GROUP BY a.opportunity_id
      ORDER BY a.opportunity_id
      LIMIT 100
    `.execute(trx);
    return result.rows;
  });
}

/**
 * Read-only review queue. Only sanitized application metadata is returned.
 * No patient data, caregiver profile, contact details or cross-tenant rows.
 */
export async function listAgencyPendingApplications(
  userId: string, organizationId: string, opportunityId: string,
) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    await requireSmartMatchAgencyAdmin(trx, userId, organizationId);
    const rows = await sql<{ id: string; status: string; created_at: string }>`
      SELECT a.id, a.status, a.created_at
      FROM smartmatch_applications a
      JOIN smartmatch_opportunities o ON o.id = a.opportunity_id
      WHERE o.id = ${opportunityId}
        AND o.organization_id = ${organizationId}
        AND o.visibility = 'INTERNAL'
        AND a.status = 'PENDING'
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT 100
    `.execute(trx);
    return rows.rows;
  });
}


/**
 * Only sanitized opportunity metadata for active caregivers in their own
 * organization. RLS independently enforces published/internal/tenant bounds.
 * No route-time or credential eligibility is asserted by this endpoint.
 */
export async function listCaregiverInternalOpportunities(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    // Caregivers hold the WORKER role and an active worker membership
    // (there is no CAREGIVER role code). Same helper the RLS policy uses.
    const membership = await sql<{ allowed: boolean }>`
      SELECT app_smartmatch_is_active_worker() AS allowed
    `.execute(trx);
    if (!membership.rows[0]?.allowed) throw new SmartMatchForbiddenError();
    const result = await sql<{
      id: string; region_label: string; role_label: string;
      starts_at: string; ends_at: string;
    }>`
      SELECT id, region_label, role_label, starts_at, ends_at
      FROM smartmatch_opportunities
      WHERE organization_id = ${organizationId}
        AND visibility = 'INTERNAL'
        AND status = 'PUBLISHED'
        AND starts_at > now()
      ORDER BY starts_at ASC, id ASC LIMIT 100
    `.execute(trx);
    return result.rows;
  });
}

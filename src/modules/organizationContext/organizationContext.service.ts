import { sql } from "kysely";
import { z } from "zod";
import { withUserContext, withTenantContext } from "../../context/tenantContext.js";
import { MembershipNotActiveError, InvalidTenantContextError } from "../../context/errors.js";

export class InvalidOrganizationIdError extends Error {
  constructor() {
    super("INVALID_ORGANIZATION_ID");
    this.name = "InvalidOrganizationIdError";
  }
}
export class OrganizationAccessDeniedError extends Error {
  constructor() {
    super("ORGANIZATION_ACCESS_DENIED");
    this.name = "OrganizationAccessDeniedError";
  }
}

export interface MeResult {
  user: { id: string; email: string | null; phone: string | null };
  organizations: Array<{
    id: string;
    name: string;
    type: string;
    membershipStatus: string;
    roles: string[];
  }>;
}

/**
 * GET /me's underlying query. Runs entirely inside withUserContext -- NOT
 * withTenantContext, because listing "every org I belong to" is precisely
 * the operation that cannot be scoped to a single organization_id in
 * advance. Relies on the auth-bootstrap self-lookup RLS policies.
 */
export async function getMe(userId: string): Promise<MeResult> {
  return withUserContext(userId, async (trx) => {
    const userRows = await sql<{ id: string; email: string | null; phone: string | null }>`
      SELECT id, email, phone FROM users WHERE id = ${userId} LIMIT 1
    `.execute(trx);
    const user = userRows.rows[0];

    const rows = await sql<{
      organization_id: string;
      name: string;
      organization_type: string;
      membership_status: string;
      role_code: string | null;
    }>`
      SELECT
        o.id AS organization_id,
        o.name,
        o.organization_type,
        om.status AS membership_status,
        r.code AS role_code
      FROM organization_memberships om
      JOIN organizations o ON o.id = om.organization_id
      LEFT JOIN user_roles ur ON ur.organization_membership_id = om.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE om.user_id = ${userId} AND om.status = 'active'
      ORDER BY o.name
    `.execute(trx);

    const byOrg = new Map<string, MeResult["organizations"][number]>();
    for (const row of rows.rows) {
      if (!byOrg.has(row.organization_id)) {
        byOrg.set(row.organization_id, {
          id: row.organization_id,
          name: row.name,
          type: row.organization_type,
          membershipStatus: row.membership_status,
          roles: [],
        });
      }
      if (row.role_code) byOrg.get(row.organization_id)!.roles.push(row.role_code);
    }

    return { user, organizations: Array.from(byOrg.values()) };
  });
}

const uuidSchema = z.string().uuid();

/**
 * Validates that `organizationId` (a CLIENT-REQUESTED selection, never
 * trusted on its own) corresponds to a real, active membership for this
 * user, by delegating to the already-approved withTenantContext() -- which
 * independently re-verifies membership before running anything. This
 * function does not duplicate that check; it reuses it.
 */
export async function validateOrganizationSelection(userId: string, organizationIdRaw: string) {
  const parsedOrgId = uuidSchema.safeParse(organizationIdRaw);
  if (!parsedOrgId.success) {
    // Rejected BEFORE any SQL touches a tenant-owned table.
    throw new InvalidOrganizationIdError();
  }
  const organizationId = parsedOrgId.data;

  try {
    return await withTenantContext({ userId, organizationId }, async (trx) => {
      const result = await sql<{ id: string; name: string; organization_type: string }>`
        SELECT id, name, organization_type FROM organizations WHERE id = ${organizationId} LIMIT 1
      `.execute(trx);
      return result.rows[0];
    });
  } catch (err) {
    if (err instanceof MembershipNotActiveError) throw new OrganizationAccessDeniedError();
    if (err instanceof InvalidTenantContextError) throw new InvalidOrganizationIdError();
    throw err;
  }
}

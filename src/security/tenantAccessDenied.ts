import { MembershipNotActiveError } from "../context/errors.js";
import { OrganizationAccessDeniedError } from "../modules/organizationContext/organizationContext.service.js";

/**
 * True when withTenantContext() refused the request because the caller is not
 * an active member of that organization (or the organization is not active).
 * Routes must answer 403 ORGANIZATION_ACCESS_DENIED, never 500: the refusal is
 * expected, carries no data, and must not look like a server failure
 * (auditoría B4, 27-oct-2026).
 */
export function isTenantAccessDenied(error: unknown): boolean {
  return error instanceof MembershipNotActiveError || error instanceof OrganizationAccessDeniedError;
}

export const TENANT_ACCESS_DENIED_BODY = { error: "ORGANIZATION_ACCESS_DENIED" } as const;

# ETNARA platform administration: tenant-private data boundary

## Policy objective
ETNARA Administration and Tower AI agents must not read agency patient/resident records, staff/caregiver files, or their contents. Operational status, subscription management, and safe aggregated platform metrics remain permissible when appropriately scoped.

## Current finding — requires remediation
`withPlatformContext` in `src/context/tenantContext.ts` verifies active `platform_admins` membership and sets `app.is_superadmin = true`. RLS checks may grant platform administrators broad access to tenant tables. Authentication and an AI prompt restriction do **not** prove tenant-private records are inaccessible. This is a security design gap to investigate, not a confirmed data breach.

## Required implementation gates
1. Inventory all tenant-owned tables and platform-admin endpoints, including establishment documents, organization credentials, staff and resident records, audit logs, exports and support tools.
2. Classify columns into platform operational metadata, tenant-private identity, workforce files, and resident/patient content.
3. Remove blanket platform-admin SELECT permissions from private tables in RLS, database grants and application query paths; use narrow platform-only views or purpose-specific functions for approved metadata.
4. Preserve tenant workflows under `withTenantContext` and explicit organization memberships. Separate operational health probes from privileged data access.
5. Add negative integration tests: a platform admin without tenant membership cannot read any private record; agency A cannot read agency B; Tower AI requests never query private tables.
6. Check logging, traces, backups, exports, support access and third-party AI payloads for private-content leakage. Redact and minimize.
7. Perform staged rollout with migration review, regression testing and rollback plan. Do not merge permission changes without confirming agency workflows still work.

## Interim rule
Do not add new Tower integrations that query tenant tables. GitHub status integrations must be read-only, repository allowlisted, and limited to non-secret metadata. AI instructions are defense-in-depth, not authorization controls.

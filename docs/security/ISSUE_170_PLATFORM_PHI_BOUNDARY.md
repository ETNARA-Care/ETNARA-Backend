# Issue #170 — Platform administration PHI boundary (security audit)

## Confirmed findings from repository review
- `src/context/tenantContext.ts` correctly verifies platform administrators against `platform_admins` before setting the privileged session context.
- `migrations/018_rls_hardening.sql` independently verifies the platform administrator identity, but `app_is_superadmin()` is still used as a blanket bypass in patient-facing RLS policies.
- `care_recipients`, `care_plans`, `care_events`, `observations`, `incidents`, `stored_files`, `resident_documents` and `establishment_documents` require policy-by-policy review.
- `scripts/verifyTenantIsolation.ts` tests cross-tenant denial for ordinary members, not the global platform administrator's lack of PHI access.

## Required change sequence
1. Inventory every `app_is_superadmin()` RLS bypass and all `withPlatformContext()` callers. Classify tables as platform operations, tenant business data, or patient/clinical PHI. Audit indirect exposures in search, notifications, logs, exports and Tower.
2. Add explicit, narrow platform administration permissions for aggregate metrics and operational metadata. Avoid granting unrestricted row-level patient access merely to compute counts.
3. Replace platform-admin PHI bypasses with tenant-scoped, membership-verified predicates. Preserve organization admin, assigned worker, and family access. For sensitive files and related tables, cover SELECT/INSERT/UPDATE/DELETE as applicable. Check other permissive policies (PostgreSQL OR semantics).
4. Design exceptional support as a separate audited and expiring capability, disabled until legal/security review and any required BAA.
5. Add negative integration tests: verified platform admin cannot read patient names, DOB, plans, clinical notes, incidents, resident documents or file contents via direct SQL/API; forged org ID fails; ordinary agency permissions remain intact.
6. Run migrations on a disposable PostgreSQL instance, execute full tests, review diff and rollback plan, then open PR for review. No production migration or merge before successful checks.

## Safety
Do not deploy a blanket `REVOKE` or redefine `app_is_superadmin()` globally: doing so may break platform-only Tower and administration flows. Do not assume the code search is exhaustive. Review the final migration ordering and all policies before shipping.

Status: audit findings documented; implementation and tests pending.

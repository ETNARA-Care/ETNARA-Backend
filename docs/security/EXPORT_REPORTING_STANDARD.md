# ETNARA Export & Reporting Security Standard

## Scope

This standard applies to any current or future feature that exports, downloads, emails, prints, batches, summarizes, or otherwise moves organization data outside its normal in-app view. Examples include CSV/XLSX/PDF exports, payroll files, compliance reports, resident lists, caregiver rosters, audit reports, scheduled reports, and API bulk-download endpoints.

## Mandatory rules

1. **Tenant context is required.** Any export containing organization data must execute through `withTenantContext({ userId, organizationId })` and must validate active membership in that exact organization.
2. **No Platform bulk access to tenant private data.** Platform routes must not export resident/patient records, caregiver or employee records, private credential documents, messages, incidents, care plans, observations, or stored file metadata/content.
3. **Platform reports are aggregate-only unless explicitly allowlisted.** Platform may export commercial/operational metadata such as subscription status, organization lifecycle, aggregate counts, and ETNARA Verified establishment-document status. No row-level tenant PHI/PII.
4. **Least-privilege role check.** A tenant export must explicitly require the minimum role needed for the dataset (for example organization manager, establishment admin, or payroll manager). An authenticated user alone is never sufficient.
5. **Explicit organization predicates.** Every query returning tenant rows must include an organization predicate or use an RLS-protected relation that is independently verified by tests. Never rely on a client-supplied organization ID without membership validation.
6. **No cross-tenant joins.** Joins must preserve the organization boundary on both sides where the schema carries `organization_id`.
7. **No raw storage keys or signed URLs in bulk exports.** Private file access remains per-resource and short-lived after authorization. Export files must not contain object-storage credentials, storage keys, access tokens, or reusable download URLs.
8. **Data minimization.** Export only fields required for the stated business purpose. Do not include internal IDs, birth dates, diagnoses, free-text notes, addresses, phone/email, credential files, or clinical content unless the feature explicitly requires them and the tenant role is authorized.
9. **No sensitive payload logging.** Never log export rows, filenames containing personal information, request bodies, user/organization IDs, emails, signed URLs, SQL text, or generated file contents. Runtime diagnostics are limited to bounded operation/name/code metadata.
10. **Safe HTTP handling.** Generated downloads must use an explicit content type and sanitized filename. Responses containing sensitive data must set `Cache-Control: no-store`.
11. **Bounded exports.** Large exports must have explicit row/date limits or a paginated/background job design. No unbounded `SELECT *` or all-tenant dump endpoints.
12. **Auditability.** Sensitive tenant exports must create an audit event containing only the actor, organization, export type, timestamp, and bounded filter metadata. Audit records must not duplicate exported private content.
13. **Tests before merge.** Every new export/report route must include:
    - authorized same-tenant success;
    - unauthorized role denial;
    - other-tenant denial using a valid foreign resource ID;
    - forged `current_org_id` denial;
    - Platform denial for private tenant data;
    - regression checks that logs do not contain exported content.
14. **ETNARA Verified exception.** Platform access to establishment-level licensing/compliance documents may remain available only through the dedicated ETNARA Verified platform service. This exception does not extend to resident or employee/caregiver documents.

## Design rule

When in doubt, produce an in-app tenant-scoped report first. Bulk export is a separate security-sensitive capability and must be reviewed under this standard before release.

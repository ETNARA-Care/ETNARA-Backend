# SmartMatch — Demo agency verification gate

SmartMatch is **not deployed**. Backend PR #179 and frontend PR #203 must remain unmerged until security validation.

## Verified isolated environment (2026-10-22)
- Railway project: `etnara-document-security-staging` (`b829c0bd-43a3-4458-82b3-c4650b840173`), environment `staging` (`651dd762-08c1-4674-97de-d11869579df1`).
- Independent PostgreSQL service and backend service exist; Railway reports both deployments SUCCESS.
- The backend service currently tracks `audit/agency-document-permissions-20261022`, **not** this SmartMatch branch. Deployment SUCCESS does **not** prove SmartMatch is deployed or that the database schema is initialized.
- Runtime logs showed PostgreSQL error 42883 from `app_advance_due_coverage_campaigns()`; database initialization remains unverified.
- Never reuse real agency, caregiver, resident or patient data in this environment.

## Migration coordination HOLD
- The user is completing five concurrent changes. Do **not** apply or publish migrations until the user confirms they are finished.
- Migration number **082 is reserved for PR #187** (agency-document privacy); SmartMatch must not claim or reuse 082.
- Do not merge PR #179, PR #203 or PR #187, apply migrations, or change any production Railway service as part of this gate.
- SmartMatch currently carries proposed migrations 078–081; reconcile these numbers against the latest main migration ledger before execution. Existing numbers may collide with other work.
- Both SmartMatch branches diverge from main; review/rebase conflicts separately, only after concurrent work is settled.

## Verification sequence (once the migration hold is lifted)
1. Verify staging database identity, backup and migration ledger; reconcile all migration numbers without overwriting existing migrations.
2. Initialize **only the isolated** PostgreSQL schema with approved migrations. Check functions, grants, FORCE RLS and restrictive policies using `app_runtime` (not the table owner).
3. Create two synthetic agencies A/B, agency admins, and fictional caregivers. No patient names, actual addresses, or production credentials.
4. Authenticate admin A: create an INTERNAL draft, list and publish. Confirm admin B cannot list, read, modify or publish A's opportunity even when given its UUID.
5. Confirm platform administrators and unauthorized agency users cannot browse private opportunities or underlying agency documents.
6. Reject invalid date ranges and NETWORK publication until network-mode opt-in and security review are complete.
7. Confirm all opportunity responses, audit logs and errors omit patient identifiers, exact service addresses and precise caregiver coordinates.
8. Connect the frontend PR #203 preview to isolated staging; switch A/B and verify stale A records never display for B.
9. Verify API tests, RLS PostgreSQL integration tests and frontend tests; record observed results and outstanding failures.

## Current limitations
- The existing agency demo UI supports draft/list/publish opportunities; this is not an end-to-end SmartMatch assignment flow.
- Caregiver discovery, route-time provider integration, location consent persistence, integrated applications, eligibility recheck and transactional assignment approval need end-to-end validation/implementation.
- CI passing and Railway deployment SUCCESS do not replace real PostgreSQL authorization tests.

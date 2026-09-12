# ETNARA Agent State

## Current Status

Project: ETNARA Care
Repository: ETNARA-Backend
Branch: phase-5/actionable-notifications

## Current Backend Checkpoint

The recovered backend work is implemented, reviewed, and published in draft PR #3:

- migrations 038/039
- messaging auto-participant fix
- idempotent participant backfill
- notifications for care events
- notifications for incidents
- family-safe curated endpoints for observations
- family-safe curated endpoints for incidents
- family-safe curated endpoints for shifts / check-in / check-out
- security fix blocking Family from raw / uncurated endpoints
- regression testing for Family data leakage

Additional corrections completed:

- Family access requires an active FAMILY membership.
- Family observations are limited to reviewed records.
- Failed migrations roll back and are not marked as applied.
- Migration execution is protected by an advisory lock.
- The demo password is supplied through `DEMO_PASSWORD`, never source code.
- Local build, 9 tests, and npm audit pass.
- GitHub CI passed on the published backend commit.

## Mandatory Next Step

PostgreSQL 16 validation now passes: all migrations install from an empty
database and a second bootstrap completes idempotently. Obtain explicit approval
before merging PR #3 and deploying it to Railway.

## Current Product Priority

Establish reliable real-data connectivity between:

- Caregiver / Worker
- Family
- Administration

Priority order:

1. Messaging
2. Administration real data
3. Care timeline / care events
4. Shifts / check-in / check-out
5. Notifications
6. Family-safe observations / incidents

## Deployment Notes

Backend staging is deployed on Railway.

Frontend is deployed through GitHub Pages.

Verify actual deployment configuration before changing deployment behavior.

## Session Handoff

### 2026-09-12 — Phase 5.4 actionable notifications and safe cancellation

- Notification responses now include the family-safe recipient id and resolve
  assignment notifications to their shift through an owner-checked,
  narrowly-scoped SECURITY DEFINER helper.
- Administrative cancellation preserves the shift and assignment history and
  is limited atomically to future, unstarted `unassigned` or `confirmed`
  shifts; invalid state changes return a conflict.
- Public helper execution is revoked; only `app_runtime` may execute it.
- Local TypeScript build and all 27 backend tests pass.
- Exact next step: publish the backend PR, pass PostgreSQL 16 migration checks,
  merge, and verify Railway migration 044 before publishing the frontend.

### 2026-09-11 — Phase 5.3 manager assignment notifications

- Confirmed live that caregiver accept/reject succeeds while the Admin inbox
  remains empty.
- Root cause: the caregiver RLS context cannot enumerate privileged manager
  memberships, so the previous notification query inserted zero rows without
  raising an error.
- Added a narrowly-scoped, idempotent SECURITY DEFINER function that first
  proves the caller is the active assigned worker and the stored response
  matches the requested notification type, then notifies only active Admins
  and Supervisors in the same organization.
- Public execution is revoked; only `app_runtime` can call the helper.
- Local TypeScript build and all 25 backend tests pass.
- Exact next step: publish, pass PostgreSQL CI, merge, verify Railway migration
  043, then validate one fresh response appears in the Admin inbox.

### 2026-09-10 — Assignment-response production diagnostics

- The caregiver shift list and detail now load, but accepting or rejecting a
  pending assignment still returns `INTERNAL_ERROR` in Railway.
- Added bounded server-side logging for unmatched `respondToMyAssignment`
  failures: operation, error name/message, and PostgreSQL code only.
- Client responses remain generic and no request body, user ID, organization
  ID, shift ID, SQL text, or clinical data is logged.
- Exact next step: deploy this diagnostic hotfix, reproduce one assignment
  response, and use the Railway error to implement the smallest proven fix.

### 2026-09-10 — Caregiver shift production diagnostics

- Railway bootstrap now completes and migration 042 is recorded, but the live
  caregiver shifts endpoint still returns `INTERNAL_ERROR`.
- Added bounded server-side logging for unmatched `listMyShifts` failures:
  operation, error name/message, and PostgreSQL code only.
- Client responses remain generic and no request body, user ID, organization
  ID, SQL text, or clinical data is logged.
- Exact next step: deploy this diagnostic hotfix, reproduce the read-only
  caregiver shifts request, and use the resulting Railway error to implement
  the smallest corrective migration or query fix.


### 2026-09-09 — Railway migration startup hotfix

- Live caregiver reads and assignment responses returned `INTERNAL_ERROR`
  after Phase 5.2 because Railway started the API without applying migration
  042 to its persistent database.
- Production startup now runs the existing idempotent staging bootstrap before
  launching the server, applying only migrations not recorded in
  `schema_migrations` and preserving existing data.
- A regression test requires the migration gate to remain in the production
  start command.
- Exact next step: validate, publish, merge after approval, then verify the
  caregiver shifts endpoint and assignment response against Railway.

### 2026-09-09 — Phase 5.2 assignment responses

- New assignments start pending; pre-existing assignments migrate as accepted.
- The authenticated assigned worker can accept or reject exactly once.
- Check-in requires an accepted assignment.
- Rejection preserves the response record and releases the shift for a new
  assignment; rejected records do not grant coverage or messaging access.
- The assigned worker and organization managers receive in-app notifications.
- Local build and all 20 backend tests pass; GitHub CI will validate every
  migration twice against PostgreSQL 16.
- Exact next step: publish the coordinated backend PR and wait for CI before
  requesting merge authorization.

### 2026-09-08 — Family-safe caregiver identity and credentials

- Family shift summaries now include the assigned caregiver display name and
  only verified, active credential summaries; document and internal review
  fields remain excluded.
- Added authenticated caregiver `GET /organizations/:id/me/credentials` using
  the worker resolved from the session rather than a client-supplied worker ID.
- Demo seed adds idempotent, explicitly fictitious verified credentials for
  María, including CPR expiring in 45 days to validate the warning state.
- Raw credential routes now reject Family; only managers/platform admins and
  the worker themself may access them.
- Backend build and 15/15 tests pass.
- Production remains unchanged. Exact next step: final diff review, commit, and
  request authorization to publish the coordinated backend PR first.

### Completed
- Backend recovery and security review completed.
- Draft backend PR #3 published.
- Local TypeScript/build/tests/audit validation passed.

### Files Changed
- Backend family-safe access, messaging, notifications, migrations, and tests.
- `.github/workflows/etnara-ci.yml` adds real PostgreSQL migration validation.

### Tests Run
- 9 local tests passed.
- TypeScript/build passed.
- npm audit reports 0 vulnerabilities.
- GitHub CI initial run passed.

### Failures / Risks
- No known validation failures remain.
- Railway deployment and post-deployment checks remain pending.
- Railway deployment remains intentionally untouched.

### Uncommitted Work
- This final validation checkpoint only.

### Exact Next Step
- With user approval, merge PR #3, monitor Railway, and verify migrations 038-040.

## 2026-09-07 — Demo shift eligibility gate

- Branch: `fix/demo-shift-eligibility`
- The staging bootstrap now creates one idempotent, organization-scoped demo
  requirement set named `Demo: membresía activa`.
- It intentionally has no mandatory credential requirements, so active demo
  worker memberships can pass the existing eligibility engine during real shift
  assignment and check-in.
- It never creates or changes a global requirement set or another organization.
- Backend TypeScript build passes; 10 tests pass.
- Exact next step: publish this isolated PR, merge only with user approval,
  monitor Railway bootstrap, then deploy the paired frontend shifts PR.

## 2026-09-07 — Assignment-to-messaging follow-up

- Branch: `fix/worker-actions-messaging`
- New worker assignments now add the linked worker user to existing
  family_agency conversations for the exact direct or room-based recipient
  context, idempotently and inside the assignment transaction.
- Migration 041 backfills workers assigned after migration 039, including the
  current live-test assignment.
- Backend TypeScript build passes; 11 tests pass.
- Exact next step: publish the isolated PR and merge only with user approval,
  then deploy the paired V23 care-actions PR.

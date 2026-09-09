# ETNARA Agent State

## Current Status

Project: ETNARA Care
Repository: ETNARA-Backend
Branch: phase-5/assignment-responses

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

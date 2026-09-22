# ETNARA Agent State

## Current Status

Project: ETNARA Care
Repository: ETNARA-Backend
Branch: fix/phase-7-7-planning-runtime

## 2026-09-22 — Phase 7.7 planning runtime hotfix

- Fixed the live forecast query by explicitly casting all planning-horizon
  parameters to PostgreSQL `integer` before date arithmetic.
- Preserved the existing manager authorization, tenant context, eligibility
  rules and read-only planning behavior.
- Added a regression that requires every date-arithmetic horizon parameter to
  remain explicitly typed.
- Backend TypeScript build and all 80 tests pass locally.
- Exact next step: publish only after explicit authorization, require CI and
  Railway deployment success, then validate the protected live endpoint.

## 2026-09-21 — Phase 7.7 predictive workforce planning

- Added a manager-only, organization-scoped forecast for 7, 14 or 30 days.
- Demand comes from real scheduled shifts and their required operational role;
  migration 057 safely backfills existing shifts from active assignments.
- Known capacity uses only currently eligible workers, declared weekly
  availability and future unavailability periods. Unconfigured availability is
  reported as uncertainty and is never invented as capacity.
- The forecast explains daily and role-specific coverage gaps, uncovered
  shifts and upcoming credential expirations without creating or changing an
  assignment.
- New shift assignments preserve the required role, and coverage campaigns
  retain the same role label.
- Backend TypeScript build and all 79 tests pass locally.
- Exact next step: validate migration 057 on PostgreSQL 16, review the final
  diff and publish only after explicit authorization.

## 2026-09-21 — Phase 7.6.2 compliance self-service

- Eligibility now selects the most specific requirement set for the worker's
  organization and internal role, with organization and platform fallbacks.
- Organization managers can read and update credential requirements by worker
  role through tenant-scoped endpoints; no endpoint accepts a manual aptitude
  value.
- Every policy change records before/after snapshots in the append-only audit
  log, and the compliance history also includes worker activation changes.
- Migration 056 requires real Admin/Supervisor authority at the RLS layer for
  organization requirement-set writes, in addition to the service guard.
- Backend PR #44 was merged after build, 75/75 tests, PostgreSQL migration
  validation and every CI check passed.
- Credential-document upload remains intentionally deferred to the final
  technical close and does not block this phase.
- Railway applied migration 056, remains healthy and serves the protected route.
- Exact next step: validate one role-policy change in the live Admin portal.

## 2026-09-20 — Caregiver identity hotfix

- Added an authenticated, tenant-scoped self-profile endpoint that resolves a
  caregiver only from the session user and active organization.
- The endpoint returns the real worker display name and organization-specific
  internal role without weakening workforce RLS or exposing another worker.
- Backend PR #42 was merged after TypeScript, 72/72 tests and all CI checks
  passed; Railway serves the new protected endpoint.
- Exact next step: validate Carlos and Rafael after signing out and back in.

## 2026-09-20 — Phase 7.6.1 platform credential verification

- Added a platform-only queue of real, current credential documents across
  organizations; organization roles cannot grant access to it.
- Platform decisions are now bound to the current stored-file version, retain
  immutable history and require an audit note on rejection.
- Work eligibility reads only the latest decision for the current file, so a
  replacement document returns to pending and a rejection blocks assignment.
- Document downloads use short-lived private URLs after platform authority and
  current-file ownership are revalidated.
- `/me` exposes independently verified platform authority, and only the exact
  demo administrator is seeded into that authority table.
- Backend PR #40 was merged after TypeScript, 71/71 tests, migration 055 and
  the full idempotent migration set passed on PostgreSQL 16.
- Railway deployed successfully: health returns HTTP 200 and the new protected
  verification-queue route returns the expected HTTP 401 without a session.
- Exact next step: validate one real document approval and one rejection using
  the demo platform administrator.

## 2026-09-20 — Demo caregiver eligibility correction

- The eligibility engine remains authoritative: active membership alone never
  grants permission to work.
- Staging bootstrap now gives every active caregiver in the exact organization
  `Cuidado en Casa Demo` a complete set of valid, fictitious and platform-
  verified demo credentials.
- The correction is idempotent, never changes another organization, never
  weakens RLS and preserves expired or revoked credential history by creating a
  new valid demo record only when necessary.
- This supplies eligible demo candidates to validate Phase 7.5 staged waves
  while the real platform-verifier workflow remains separate.
- Backend TypeScript build and all 67 tests pass.
- Exact next step: review the final diff, commit locally and publish only after
  explicit authorization.

## 2026-09-20 — Phase 7.5 staged coverage escalation

- A coverage campaign now snapshots every currently recommended candidate and
  exposes only one ranked wave of three caregivers at a time.
- Each wave has a bounded 30-minute response window. A concurrency-safe
  background worker expires unanswered offers and activates the next wave;
  an all-declined wave progresses immediately.
- One interested response stops further escalation. ETNARA never creates an
  assignment; Administration retains the existing final assignment action.
- Queued caregivers cannot see an offer before activation and every caregiver
  continues to receive only the work window and requested role.
- Assignment or cancellation withdraws pending and queued offers without
  deleting campaign history. Exhausted campaigns can be retried explicitly.
- Backend PR #37 was merged after TypeScript, 67/67 tests, PostgreSQL 16
  migration validation, invitation verification and diff safety passed.
- Railway applied migration 054 and the production health endpoint returned
  HTTP 200 before the frontend was published.
- Exact next step: validate one timed second-wave progression with real roles.

## 2026-09-20 — Coverage-offer response hotfix

- Live validation reproduced an HTTP 500 after María selected "Estoy
  disponible" on a valid Phase 7.4 offer.
- The worker transaction was attempting to enumerate privileged manager
  memberships directly; tenant RLS correctly blocks that lookup.
- Migration 053 adds a narrowly scoped, validated SECURITY DEFINER notifier,
  matching the established assignment-response notification pattern.
- Published and merged in backend PR #36; Railway deployment and the live
  caregiver response were successfully validated.

## 2026-09-20 — Phase 7.4 collaborative open-shift offers

- Administration can offer an uncovered shift to the three highest-ranked
  eligible and available caregivers without creating an assignment.
- Caregivers receive only the work window and requested role; resident identity,
  care plans and clinical information remain unavailable before assignment.
- Each caregiver explicitly answers available or unavailable, and Administration
  sees the responses while retaining mandatory final assignment control.
- Campaigns and offers are organization-scoped with row-level security,
  duplicate-open-campaign protection and transactional shift-state locking.
- A final assignment closes the campaign and withdraws every pending offer.
- Backend TypeScript build and all 61 tests pass.
- Published and merged in backend PR #34. Pull-request CI, PostgreSQL 16
  migration validation and Railway deployment passed; health returned HTTP 200
  and the protected coverage-offer route is live.
- Exact next step: validate one Admin → caregiver → Admin response cycle using
  real organization roles.

## 2026-09-20 — Availability save hotfix

- Added `PUT` to the exact-origin CORS allowlist so the GitHub Pages caregiver
  portal can complete the availability-save preflight.
- Added migration 051 granting the least-privilege `app_runtime` role access to
  the three availability tables; tenant RLS remains authoritative.
- Backend TypeScript build and all 57 tests pass.
- Exact next step: publish and validate the live preflight and save workflow.

## 2026-09-20 — Phase 7.3 worker-declared availability

- Caregivers can maintain their own weekly work windows and future periods of
  unavailability through an authenticated, organization-scoped API.
- Migration 050 stores availability separately from assignments, protects it
  with manager-or-self row-level security and preserves eligibility as the
  authoritative work gate.
- Coverage recommendations now explain declared availability and exclude a
  configured caregiver when the proposed turn falls outside it or overlaps a
  time-off block.
- Unconfigured availability remains a visible, non-blocking rollout state;
  ETNARA never creates an assignment from a recommendation.
- Backend TypeScript build and all 56 tests pass.
- Published and merged in backend PR #31. Pull-request and post-merge CI passed;
  Railway health returned HTTP 200 and the protected availability route is live.
- Exact next step: validate one saved caregiver schedule and one blocked
  coverage recommendation through the live role workflow.

## 2026-09-19 — Phase 7.2 assisted coverage intelligence

- Added a manager-only recommendation endpoint for a real resident and shift
  window; it performs no assignment mutation.
- Candidates are ranked deterministically from fresh work eligibility,
  schedule conflicts, completed-shift continuity and upcoming seven-day load.
- Ineligible workers and workers with overlapping pending/accepted shifts are
  never marked recommended, and every candidate includes reasons and blockers.
- Backend TypeScript build and all 53 tests pass.
- Published and merged in backend PR #30. Pull-request and post-merge CI
  passed; Railway health returned HTTP 200 and the protected recommendation
  route returned the expected unauthenticated response.
- Exact next step: validate one recommended and one blocked candidate through
  the live Administration workflow.

## 2026-09-19 — Phase 7.1 individual care plans

- Activated the existing versioned `care_plans` model through a real API.
- Plan details now have a validated structure for support level, goals,
  instructions, precautions and caregiver tasks.
- Saving creates a new version, supersedes the prior active version and never
  deletes plan history.
- Migration 049 narrows plan reads to managers and assigned workers and limits
  writes to managers; Family receives no raw plan endpoint.
- Backend TypeScript build and all 50 tests pass.
- Phase 7.1 was published and merged in backend PR #29; CI and Railway health
  validation passed before the paired frontend deployment.

## 2026-09-15 — Phase 6 end-to-end operational synchronization

- Check-in and final checkout now create idempotent, recipient-scoped in-app
  notifications for active organization managers and opted-in authorized
  Family members.
- Notification responses expose the shift destination without leaking
  verification method, location or other operational details to Family.
- The accepted-assignment and current work-eligibility gates remain
  authoritative before check-in; care activities still require an active
  visit, and incident/message authorization remains unchanged.
- Phase 5.9 private-document transport remains deferred and isolated.
- Backend build and all 47 tests pass.
- Exact next step: publish the coordinated Phase 6 backend/frontend changes
  after explicit authorization, deploy backend first, then validate one full
  Admin → María → Family turn in staging.

## 2026-09-13 — Secure credential upload hotfix

- Live Safari validation proved that credential metadata saves correctly while
  direct browser PUTs to the Railway bucket are blocked by bucket CORS.
- Added an authenticated, manager-only binary upload endpoint that validates
  organization/worker/credential/file ownership, MIME type and the declared
  byte length before the backend writes the private object to Railway storage.
- The existing completion step still performs a HEAD check and preserves the
  immutable document-version and review history.
- No authentication, RLS, Family exposure or database schema changed.
- Local TypeScript build and all 42 backend tests pass.
- Exact next step: publish, merge, wait for Railway, then deploy the paired
  frontend and validate one PDF/JPG/PNG upload from Safari.

### Live follow-up

- The frontend and backend hotfixes were confirmed live, but Railway still
  returns a generic server error while writing or verifying the object.
- Added bounded diagnostics containing only operation, error name/code and HTTP
  status. No tenant, worker, credential, filename, object key, request body,
  database statement or storage secret is logged.
- Exact next step: deploy the diagnostic, reproduce once, inspect Railway logs,
  then correct the proven storage-provider response.

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

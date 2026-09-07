# ETNARA Agent State

## Current Status

Project: ETNARA Care
Repository: ETNARA-Backend
Branch: codex/fix-cross-portal-security

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

Validate all migrations twice against the disposable PostgreSQL 16 service in
GitHub Actions. The first run exposed a hard-coded `caretest` database name in
migration 017; migration 040 and the fresh-install correction must pass before
PR #3 is merged or deployed to Railway.

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
- The first PostgreSQL integration run correctly failed at migration 017 because
  it granted access to a hard-coded `caretest` database. A portability fix and
  additive migration 040 are pending CI validation.
- Railway deployment remains intentionally untouched.

### Uncommitted Work
- Updated CI migration validation and this checkpoint.

### Exact Next Step
- Publish the CI update to PR #3 and require a successful PostgreSQL migration run.

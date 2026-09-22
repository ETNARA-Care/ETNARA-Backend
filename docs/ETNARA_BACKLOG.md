# ETNARA Backlog

## In Progress

### ETN-030 — Phase 7.7 predictive workforce planning

- forecast workforce capacity for the next 7, 14 or 30 days
- compare real shift demand by role with eligible declared availability
- explain coverage gaps, uncovered shifts, uncertainty and credential expiry
- remain read-only and preserve human assignment authority
- keep the contract manager-only and organization-scoped

Status: Implemented locally on `phase-7/7.7-predictive-workforce`; TypeScript
build and 79/79 tests pass. PostgreSQL 16 migration validation remains before
publication.

---

### ETN-026 — Demo caregiver eligibility correction

- provision valid fictitious credentials only inside `Cuidado en Casa Demo`
- include every active demo caregiver so staged waves can be exercised
- keep production eligibility, platform verification and RLS authoritative
- preserve credential history and idempotent staging bootstrap behavior

Status: Implemented locally; backend TypeScript build and all 67 tests pass.
Publication requires explicit authorization.

---

### ETN-025 — Phase 7.5 staged coverage escalation

- keep a ranked, auditable queue for every open coverage campaign
- activate only one wave of three caregivers with a bounded response window
- advance automatically after timeout or immediately after an all-declined wave
- stop escalation on interest while preserving mandatory human assignment
- hide queued offers from caregivers and preserve pre-assignment privacy
- withdraw pending and queued offers when a shift is assigned or cancelled

Status: Complete — published and merged in backend PR #37; CI, PostgreSQL 16
migration validation and Railway deployment passed.

---

### ETN-023 — Availability save hotfix

- permit `PUT` in the production portal's exact-origin CORS policy
- grant availability-table operations to the least-privilege runtime role
- preserve row-level tenant isolation and authenticated self-only writes

Status: Implemented locally; backend build and 57/57 tests pass. Publication
authorized.

---

### ETN-022 — Phase 7.3 worker-declared availability

- let each linked caregiver maintain weekly work windows and time-off blocks
- protect availability with organization-scoped manager-or-self RLS
- incorporate declared availability into explainable coverage recommendations
- keep unconfigured availability non-blocking during rollout
- preserve eligibility gates and explicit human assignment confirmation

Status: Published and merged in backend PR #31. Pull-request and post-merge CI
passed; Railway health and protected-route checks succeeded.

---

### ETN-021 — Phase 7.2 assisted coverage intelligence

- rank active caregivers for a real resident and shift window
- require current work eligibility and exclude schedule conflicts
- explain continuity and upcoming seven-day workload without inventing data
- keep the recommendation read-only and require human assignment confirmation

Status: Published and merged in backend PR #30. Pull-request and post-merge CI
passed; Railway health and protected-route checks succeeded.

---

### ETN-020 — Phase 7.1 individual care plans

- create versioned, resident-scoped care plans with support level, goals,
  instructions, precautions and structured tasks
- restrict plan management to organization managers
- allow read access only to managers and workers assigned to the resident
- preserve every previous version and prohibit deletion
- keep Family off the raw operational care-plan contract

Status: Published and merged in backend PR #29; CI and Railway health checks
passed before the paired frontend deployment.

---

### ETN-019 — Phase 6 end-to-end operational synchronization

- notify authorized Admin and Family when an accepted caregiver starts or
  completes a shift
- preserve accepted-assignment and current work-eligibility gates
- keep notifications recipient-scoped, idempotent and Family-safe
- validate the same shift across Admin, Caregiver and Family

Status: Implemented locally; backend build and 47/47 tests pass. Coordinated
publication requires explicit authorization.

---

### ETN-017 — Safari-safe private credential upload

- proxy the authenticated document body through the backend when the private
  Railway bucket does not authorize cross-origin browser PUTs
- validate manager authority, tenant ownership, MIME type and exact byte size
- preserve the existing private bucket, completion verification and versioning

Status: Implemented locally; build and 42/42 tests pass. Publication authorized.

Live follow-up: browser and API deployments are current, but the server-to-
bucket operation still fails. Bounded provider diagnostics are being deployed;
the next correction must follow the actual Railway error code.

---

### ETN-015 — Phase 5.4 actionable assignment notifications

- resolve user-owned assignment notifications to their shift
- preserve assignment ids as the audited related entity
- restrict cancellation to future, unstarted shifts
- preserve cancelled shift and assignment history

Status: Implemented and validated locally; PR publication pending.

---

### ETN-014 — Diagnose live assignment-response failure

- preserve the generic `INTERNAL_ERROR` client response
- log only bounded technical metadata for `respondToMyAssignment`
- reproduce against Railway and correct the proven database/query fault

Status: Diagnostic logging implemented; TypeScript build and all 23 tests pass.

---

### ETN-013 — Diagnose live caregiver shift read failure

- preserve the generic `INTERNAL_ERROR` client response
- log only bounded technical metadata for `listMyShifts`
- reproduce against Railway and correct the proven database/query fault

Status: Diagnostic logging implemented; TypeScript build and all 22 tests pass.

---

### ETN-012 — Railway migration startup gate

- apply pending migrations before serving requests
- preserve the existing idempotent migration ledger and demo seed
- block deployment when the production database cannot be upgraded safely
- verify the live caregiver shift and assignment-response contracts

Status: Hotfix implemented locally; validation and PR publication in progress.

---

### ETN-011 — Caregiver assignment response

- pending → accepted/rejected transition
- assigned-worker-only response authority
- check-in gate and duplicate-response protection
- caregiver/admin notifications
- rejected assignment audit preservation

Status: Implemented and validated locally on `phase-5/assignment-responses`;
PR publication in progress.

---

### ETN-010 — Family-safe caregiver credentials

- add caregiver self-credential summary
- add assigned caregiver name and verified credential summary to family shifts
- seed idempotent demo credentials for María
- preserve document and internal review privacy

Status: Implemented and validated locally on
`feature/shift-incidents-credentials`; PR publication pending.

---

### ETN-003 — Commit and push backend
- draft PR #3 published
- PostgreSQL validation found and corrected migration 017 database-name coupling
- additive migration 040 ensures existing databases receive the correct grant
- all migrations and a second idempotent bootstrap passed on PostgreSQL 16
- merge and Railway deployment intentionally pending

---

## Next

### ETN-029 — Phase 7.6.2 compliance self-service
- manager-only credential requirements by caregiver role
- exact eligibility causes continue to come from the authoritative engine
- append-only audit history for policy and membership-status changes
- RLS-enforced Admin/Supervisor write authority
- local build and 75/75 tests pass

Status: Complete — published and merged in PR #44; all CI and PostgreSQL\nmigration checks passed, and Railway serves the protected route.

### ETN-028 — Caregiver self-identity correction
- resolve the real worker profile from authenticated user + active organization
- preserve tenant RLS and return no other caregiver identity
- local build and 72/72 tests pass

Status: Complete — published and merged in PR #42; CI and Railway deployment
passed.

### ETN-027 — Phase 7.6.1 platform credential verification
- independent platform-admin authority
- current-file verification queue and private document access
- auditable verify/reject decisions with required rejection notes
- automatic eligibility recalculation without a manual apt override
- local build and 71/71 tests pass

Status: Complete — published and merged in PR #40; PostgreSQL 16 migration
validation and Railway deployment passed.

### ETN-024 — Phase 7.4 collaborative open-shift offers
- secure, tenant-scoped offer campaigns for uncovered shifts
- first controlled wave targets the top three eligible recommendations
- caregiver interest never creates an automatic assignment
- final assignment closes the campaign and withdraws pending offers
- local build and 61/61 tests pass

Status: Complete — published and merged in PR #34; CI, PostgreSQL 16 migration
validation and Railway deployment passed.

### ETN-004 — Connect Administration to real backend data
Repository: ETNARAMVP

- rewrite AgencyResidentProfilePage.tsx
- remove mock data where real backend endpoints exist
- preserve current UI

### ETN-005 — Messaging across Worker / Family / Admin
- verify authorized participants
- verify backfill
- verify no duplicate threads/participants
- verify admin visibility

### ETN-006 — Real-data shifts and check-in/out
- caregiver writes
- admin sees operational data
- family sees family-safe summary

### ETN-007 — Notifications
- messages
- care events
- incidents
- correct recipients by role

### ETN-008 — Family-safe observations and incidents
- curated endpoints
- correct RLS
- no raw data leakage

### ETN-009 — End-to-end role validation
Test with:
- maria@demo.etnara.care
- familia@demo.etnara.care
- admin@demo.etnara.care

Validate the same care recipient across all roles.

---

## Completed

### SETUP-001 — Create AGENTS.md
Status: Complete

### SETUP-002 — Create AGENT_STATE.md
Status: Complete

### ETN-001 — Recover previous backend work
Status: Complete

### ETN-002 — Backend review and security validation
Status: Complete — TypeScript, build, 9 tests, authorization review, leak regression, and dependency audit passed.

---

## Rules

- Work on one backlog item at a time.
- Do not silently expand scope.
- Update AGENT_STATE after each task.
- Mark items complete only after validation.
- If a session ends early, preserve the exact next step.

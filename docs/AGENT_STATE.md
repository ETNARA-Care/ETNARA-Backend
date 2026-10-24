# ETNARA Agent State

## Current Status

## 2026-10-24 — Activity photos PR 2: upload, review, family viewing, HEIC (claude/activity-photos-upload, #208 draft)

- 116: one photo per activity, family access log (managers read), checked functions for upload, view,
  consent form and review with optimistic concurrency (`expectedStatus` → 409 PHOTO_STATUS_CHANGED).
- Separate private bucket `etnara-activity-photos` (Railway, ams) created 2026-10-24 with Rafa's
  approval; `PHOTO_STORAGE_*` set on the backend only as references (no redeploy). No public links,
  no presigned URLs; images streamed by the backend with permission checks on every request.
- Server-side sanitising: JPEG/PNG/WebP/AVIF via sharp; iPhone HEIC/HEIF via libheif (WASM, heic-decode
  2.1.0) in a worker thread (2 at once + 8 queued, then 503 PHOTO_BUSY; 30 s timeout; > 50 MP refused
  before decoding). Output always re-encoded JPEG, no EXIF/GPS/XMP/ICC (checked).
- Tests (synthetic images only, fixtures in tests/fixtures/*.heic): upload verifier 25/25, security
  31/31, npm test 500/500, full regression green. ACTIVITY_PHOTOS off everywhere; 180-day deletion off.
- Eligibility (approved by Rafa 2026-10-24): GET .../shifts/:id/photo-eligibility and
  .../care-events/:id/photo-eligibility → only { canAttach }. Upload re-checks everything (org, resident,
  author still with an ACCEPTED assignment on a non-cancelled shift, ≤ 12 h, consent) and holds the capture
  consent FOR SHARE until commit (revocation first → 409; revocation later waits). Verifier 33/33.
- Storage self-check at backend start (log PHOTO_STORAGE_SELF_CHECK, yes/no only) + scripts/checkPhotoStorage.ts.
- Next: Rafa's authorization to merge/deploy #208; frontend PR 3 (Caregiver Portal capture/upload).

## 2026-10-23 — Security & production-readiness audit, SmartMatch Gates 4-7 (claude/smartmatch-gate1-rls)

- Three independent reviews (RLS/permissions, integrity/concurrency, frontend/deps) + own checks of
  production compatibility. Report: Project doc claude/smartmatch-audit-report.md.
- 107 (narrows access, no data deleted): users writes own-row only (CRITICAL, pre-existing 014: any
  member could overwrite another user's email/password at DB level); shifts worker policy SELECT +
  status-only (HIGH: caregiver could move/re-point/delete their shift); cancelled shift final, completed
  only re-opens via check-in; schedule locked once journey/arrival exist; family_relationships reads
  scoped to people the reader is authorised for, inserts managers only (self-insert removed); Tower
  restrictive deny on notifications (own only) and SmartMatch tables; cross-agency jobs refuse user
  sessions; «Llegué» window (start-2h..end); upcoming shifts pinned to their address (backfill +
  trigger); history append-only; alert dedupe/closing on cancel/rejection; batch journey states;
  FILLED cancellable when its shift lost the caregiver.
- Code: updateShift manager-only (HIGH, HTTP); legacy PUT location keeps unsent fields, locks, notifies;
  arrival race → replay; review note hidden from caregivers; per-session write limit on new routes;
  «Hoy en ruta» range predicate + overnight; proxy-addr 2.0.8; ARRIVAL_ERROR code-only log.
- verifySecurityAudit 22/22 (negative control without 107: 9/22); CI replica 21/21; npm test 443/443.
- Compatibility: production frontend (main) against this backend 5/5; main's verifiers on the new
  schema pass except Phase 12.1 address save (rollback limitation: roll forward, backup first).

## 2026-10-23 — Gate 7 «ETNARA En Camino» (claude/smartmatch-gate1-rls)

- Decisions (user): all active authorised relatives see the journey; declared delays shown as declared
  (never an ETA); «Voy en camino» from start-2h to start+1h; agency alerts: no departure 30 min before
  (preventive), no arrival start+15 (existing 101), declared delay >= 30; family notices en camino,
  llegó, retraso, iniciado, finalizado; arrival under review shown to family only as «Llegada
  registrada»; delay reasons are categories (no free text). No GPS, no tracking, no routes, no ETA.
- 106: shift_journey_events (append-only, no coordinate columns, FORCE RLS + platform_phi_deny; insert
  by the assigned caregiver only; BEFORE INSERT validation in the DB: accepted assignment, confirmed
  shift, window, before arrival/check-in, delays <= 3 and not repeated, advisory lock per shift);
  app_shift_journey_state (derived: UNASSIGNED..CANCELLED; family gets no review flag); family notices
  via app_notify_shift_family (accepted assignment, not cancelled, can_receive_notifications,
  deduplicated); SHIFT_NOT_EN_ROUTE (worker tick) and SHIFT_DELAY_REPORTED (>= 30) to managers,
  resolved by departure / arrival / check-in.
- Reused: shift_arrivals, verification_events, SHIFT_STARTED / SHIFT_COMPLETED (no duplicate family
  notices), family-shifts endpoint (+journey), 60 s worker.
- Fixed (pre-existing): SHIFT_COMPLETED was never sent (status set to completed before notifying; 076
  hides completed shifts from the caregiver). Now notified first, same transaction.
- API: GET/POST .../shifts/:id/journey[/en-route|/delay] (idempotent, clientEventId, 404 when not the
  caller's shift), GET .../operations/journeys (managers). verifyGate7Journey 36/36 (added to both CI
  workflows); staging verifier G13-G15; npm test 437/437; CI replica 20/20.

## 2026-10-23 — Gate 6 close: family write authority, approvals vs shifts (claude/smartmatch-gate1-rls)

- Finding (wider than reported): family_relationships_own_or_staff (014, FOR ALL, no WITH CHECK) let any
  active member -- relatives (they hold an active membership) and caregivers -- update/insert/delete
  relationships in their org at DB level: own can_view_photos / can_participate_in_verification,
  re-point to another person, self-insert, revoke/delete others. HTTP: POST .../family/:id/revoke had no
  role check (any member could revoke another family's access).
- 104: reads unchanged (family_relationships_read = 014 USING); UPDATE/DELETE managers only; INSERT
  managers, or self-insert from own pending unexpired family invitation with default permissions
  (SECURITY DEFINER app_family_invitation_allows_self_insert); subject immutable trigger. Revoke route
  manager-only (403 FAMILY_MANAGER_ONLY). Secure access activation (SECURITY DEFINER) unaffected.
- 105: street / municipality / establishment change also clears the GPS confirmation (ZIP alone does not).
- Approving a family correction that changes the address used by upcoming shifts needs
  confirmUpcomingShifts:true (409 UPCOMING_SHIFTS_NEED_CONFIRMATION); shifts are never rewritten;
  assigned caregivers get SHIFT_LOCATION_CHANGED (also on the admin's own place edit).
- Noted, not fixed: legacy POST /family-invitations/accept fails since 086 (invitee cannot re-read the
  invitation); the product uses /access-invitations.
- Verifier 93/93 (control without 104: 4 FP checks fail); staging verifier 67; npm test 428/428; CI replica 19/19.

## 2026-10-23 — Gate 6 fix: GPS confirmation separate from address verification (claude/smartmatch-gate1-rls)

- iPhone finding: «Verificada» appeared without an exact point and navigation went to a street
  approximation. Two independent states now: verified_at (written address checked) and
  gps_confirmed_at/gps_confirmed_by_user_id (an admin explicitly confirmed the map point).
- 103 (additive): the two columns + CHECKs (pair; confirmed requires lat/lng); reverify trigger now
  clears verified_at on written-address edits and gps_confirmed_* on lat/lng edits; history kinds
  GPS_CONFIRMED / GPS_CHANGED. Existing rows keep verified_at; legacy coordinates stay unconfirmed.
- POST .../service-locations/:id/confirm-gps (managers; {latitude, longitude, confirm:true}; PR bounds).
  Shift service-location returns coordinates only when GPS is confirmed (+ gpsConfirmed); options
  carry gpsConfirmed; arrival proximity uses only confirmed coordinates (else NO_REFERENCE).
- verifyGate6ServiceLocations 82/82 (negative control 78/82); staging verifier +G9..G11 (66 checks,
  read-only probes); npm test 423/423; CI PostgreSQL replica 19/19.

## 2026-10-23 — Gate 6: service location, arrival, FILLED cancellation (claude/smartmatch-gate1-rls)

- User decisions: OpenStreetMap map without geocoding; proximity computed on the server and
  discarded (result + rounded distance only, radius 200 m); "Llegué" + "Iniciar" + "Finalizar";
  family address permission per relative, off by default.
- 100: care_recipient_locations (084) extended, not replaced: several addresses (primary/alternates),
  ZIP, verification (cleared on edit), establishment reuse without copy, history trigger, worker
  access log, shifts.service_location_id + audited changes, worker reads only the address of a shift
  assigned now, family read behind can_view_service_location (manager-only trigger), family
  correction requests with notifications. FORCE RLS + platform_phi_deny on every new table.
- 101: worker_location_consents (versioned, revocable), shift_arrivals (no coordinate columns,
  review path), SHIFT_LATE_ARRIVAL notices (app_notify_late_shift_arrivals + API background worker).
  Check-in/out no longer store device coordinates.
- 102: FILLED -> CANCELLED with reason category; blocked while a linked shift is active.
- verifyGate6ServiceLocations.ts 70/70 (negative control 66/70); staging verifier 61 checks; seed adds
  a synthetic address and familia@agencia-a.invalid. Full CI PostgreSQL replica 19/19.

## 2026-10-23 — SmartMatch Gate 5: Crear turno con esta cuidadora (claude/smartmatch-gate1-rls)

- Decision (user, option A): approval keeps meaning FILLED, no assignment. A separate admin action
  creates ONE real shift in the existing Turnos module, schedule/role fixed to the opportunity.
- Migration 099 (additive): smartmatch_opportunities.shift_id (unique, composite FK same agency,
  only FILLED, write-once trigger); shift_private_instructions (FORCE RLS: agency managers + the
  assigned worker via app_worker_has_shift_assignment; no family policy; platform_phi_deny).
  Reason: shifts rows are readable by family (shifts_family_read) -- instructions never go there.
- Turnos services: extracted insertShiftInTransaction / assignWorkerToShiftInTransaction (existing
  endpoints call them; behavior unchanged). POST .../smartmatch/opportunities/:id/shift does lock,
  re-validation (membership, credentials, availability, active recipient of the agency), shift,
  assignment (eligibility, duplicates, overlaps, SHIFT_ASSIGNMENT_PENDING), instructions, link in
  ONE transaction. GET .../shift-draft; GET/PUT .../shifts/:id/private-instructions.
- verifySmartMatchShifts.ts 30/30 (CI); staging verifier now 52 checks (T0-T9, cancels its shift).
- Gate 1 guard test tightened: only the RESTRICTIVE platform_phi_deny may mention app_is_superadmin().

## 2026-10-23 — SmartMatch Gate 5: notifications + privacy validation (claude/smartmatch-gate1-rls)

- Migration 098: AFTER INSERT trigger on smartmatch_application_events writes into the existing
  `notifications` table (in_app, no care_recipient_id). SUBMITTED -> every active admin of the
  same agency (not the applicant); APPROVED/REJECTED/CLOSED(OPPORTUNITY_FILLED) -> the caregiver,
  and the admins' SUBMITTED notification is marked read. Partial unique index makes it idempotent.
- Role label: predefined options or validated free text (no digits, honorifics, clinical or
  address words, max 60). Region must be one of the 78 Puerto Rico municipalities.
- Event history exposes consent_version on SUBMITTED (auditable consent).
- verifySmartMatchNotifications.ts 25/25 (12/25 without 098); verifySmartMatchDecisions.ts 49/49
  (E7 credential revoked after review -> blocked, H6 consent); staging HTTP verifier 44 checks.
- Next: Turnos integration ("Crear turno con esta cuidadora"), architecture review first.

## 2026-10-22 — SmartMatch Gate 3: integration hardening, two-agency flow (claude/smartmatch-gate1-rls)

- Catalog audit of every SmartMatch policy/grant/trigger found 4 gaps, each confirmed as
  app_runtime: FILLED could be reopened; schedule/place/role editable after publishing;
  opportunities insertable as PUBLISHED/FILLED; withdrawals could carry decision data.
  Migration 097 closes them (status-machine trigger binding every writer, terms locked
  after publish, INTERNAL DRAFT-only insert with server ids/timestamps, clean withdrawal).
- Publishing: any administrator of the agency may publish its drafts (was creator-only).
- scripts/verifySmartMatchTwoAgencyFlow.ts: 66 HTTP checks, two agencies in parallel,
  cross-agency/family/supervisor/platform attacks, history privacy, zero assignments.
  Negative controls: without 097 -> 69/77 RLS; old publish rule -> 58/64 flow.
- Railway etnara-smartmatch-staging: DATABASE_URL references its own Postgres (isolated)
  but as the superuser, i.e. RLS would be bypassed; NODE_ENV invalid. See Gate 3 report.

## 2026-10-22 — SmartMatch Gate 2: agency decisions, re-apply, history (claude/smartmatch-gate1-rls)

- Migration 096: re-apply after withdrawal (partial unique index: one non-withdrawn
  application per caregiver/opportunity; rejected/approved still block); deferred
  constraint trigger rejects a submission that commits after the opportunity closed;
  agency decision UPDATE policy (admin of own agency, PENDING only, never own
  application, signed by session user); approval CHECK requires server checks (COALESCE:
  a NULL CHECK would otherwise pass); append-only smartmatch_application_events written
  only by trigger (not audit_log: every org member can read audit_log); opportunity
  policy split so an admin other than the creator can mark FILLED (092's FOR ALL
  WITH CHECK created_by = me blocked it); created_by/organization_id not updatable.
- Service/routes (smartmatch.applications.*): apply (consent v1), withdraw, my-applications,
  review queue, review with live checks, decision (lock opportunity -> application, fresh
  credentials via evaluateWorkerEligibilityInTransaction, availability, consent; blocks when
  unverifiable; FILLED, no assignment; closes other pending as OPPORTUNITY_FILLED), events.
- scripts/verifySmartMatchDecisions.ts: 47 HTTP checks incl. concurrency (stress 15/15);
  verifySmartMatchRls.ts now 63 checks. Both wired into CI.
- Next step (Gate 3/4): integration hardening, then frontend-v23 UI.

## 2026-10-22 — SmartMatch Gate 1: real caregiver role, network lock, applications RLS (claude/smartmatch-gate1-rls)

- Root cause of the RLS recursion seen in Gate 0: the SmartMatch branch predated main's
  079/081 recursion fixes. Not schema drift: confirmed read-only via the live deploy log
  (079/081 registered; no SmartMatch migrations applied there). Main merged into this branch.
- Migration 095: caregiver access = WORKER role + active worker membership (094 required a
  non-existent CAREGIVER role, so discovery always returned 0 rows); NETWORK blocked by a
  CHECK constraint (applies to every writer); caregiver submit/read/withdraw policies with
  required consent (consented_at + consent_version); organization_id denormalized onto
  applications with a composite FK so policies are acyclic under FORCE RLS; agency
  policies moved onto app_is_org_admin(). No approve/reject privilege for app_runtime.
- scripts/verifySmartMatchRls.ts: 47 attacks as app_runtime on the real migration chain
  (wired into etnara-ci.yml and smartmatch-postgres.yml, which no longer uses a fake schema).
  Negative control without 095: 37/47 (detects role and NETWORK bugs).
- Next step (Gate 2): transactional decision function + endpoints (apply, withdraw,
  my-applications, eligibility, approve/reject → FILLED, no assignment).
## 2026-10-22 — Phase 12.4 offline check-in/out + caregiver session (gate/12.4-offline-mode)

- Migration 087 (additive): verification_events.client_event_id (unique per
  org + worker membership) and recorded_offline. Definer
  app_find_own_verification_event() answers a late retry for the caller's own
  record after the visit closed (076 hides it otherwise).
- check-in/out accept clientEventId, occurredAt, recordedOffline. occurredAt:
  not in the future (2 min skew), not older than 7 days, check-out after its
  check-in. A retry returns the stored row (200, replayed); concurrent
  retries are safe (ON CONFLICT). recorded_offline = device waited for
  signal OR arrived > 2 min late. Timesheet hours use the real times.
- getVerification exposes recordedOffline; agency timesheets expose
  recorded_offline.
- Login: caregiver-only accounts (only WORKER, active) get
  WORKER_SESSION_DURATION_HOURS (default 168, max 168) and keepSignedIn=true.
  Staff, family and platform keep SESSION_DURATION_HOURS.
- scripts/verifyOfflineCheckInOut.ts (17 checks, in CI). Full regression on
  a fresh DB: all verify scripts PASS; 338 unit tests.

## 2026-10-22 — Phase 12.4a close open tenant policies (gate/12.4a-close-open-tenant-policies)

- Migration 086: the PERMISSIVE FOR ALL "<table>_tenant_isolation" policy on 12
  tables (assignments, assignment_history, consent_records, family_invitations,
  organization_memberships, organization_worker_memberships, professional_scope,
  user_roles, verification_events, verification_overrides, worker_eligibility,
  worker_roles) let any active member (family, caregiver) read AND write every
  row of the organization. Each is now RESTRICTIVE (same org + active
  membership, or platform; self lookup and legacy token lookup kept).
- Reads: structural tables keep a member_read inside the agency (messaging,
  notifications and /me depend on it). verification_events and assignments
  writes go only through the existing manager / own-worker / family policies;
  check-ins are no longer readable by other caregivers.
- Writes: managers (definer helper), establishment admins for caregiver
  memberships and eligibility, the caregiver for its own eligibility. 085
  authority still limits memberships/roles.
- New definer helpers: app_is_any_establishment_admin(),
  app_is_own_worker_membership(id), app_shift_has_open_check_in(shift) — used by
  check-out so a co-worker still on the shift keeps it in progress.
- scripts/verifyTenantPolicyClosure.ts (22 checks, in CI): failed 13/22 before
  086, 22/22 after. Full regression on a fresh DB: all verify scripts PASS;
  332 unit tests; HTTP smoke identical to baseline.
- Follow-ups: tighten reads on structural tables per role; legacy
  POST /family-invitations/accept is unused and already blocked by 085.

## 2026-10-22 — Phase 12.3 staff roles + existing accounts (gate/12.3-staff-roles-existing-accounts)

- POST /organizations/:id/team/roles {membershipId | workerMembershipId, role,
  enabled}: ORGANIZATION_ADMIN gives or removes SUPERVISOR/ADMINISTRATOR to
  someone already in the agency. A caregiver keeps WORKER (decision: both
  roles). Guards: cannot remove own admin, never the last admin (advisory
  lock), caregiver must have an activated account. RLS from 085 unchanged.
- Team list exposes workerMembershipId for staff who also work shifts.
- POST /platform/admin-invitations/accept (authenticated): an existing ETNARA
  account accepts a staff invitation; the SQL function checks the invited email
  is this user (INVITATION_IDENTITY_MISMATCH otherwise).
- Verification: scripts/verifyStaffRolesAndExistingAccounts.ts 18/18 in CI.
  No migration.

## 2026-10-22 — Phase 12.2 team invitations + administrator authority (gate/12.2-team-invitations-admin-authority)

- Migration 085:
  - SECURITY DEFINER helpers app_is_org_admin(), app_is_org_manager_definer(), app_role_code().
  - CLOSED A PRIVILEGE GAP: user_roles and organization_memberships had one
    permissive FOR ALL policy without WITH CHECK, so any active member
    (caregiver, family) could write roles/memberships directly as app_runtime.
    RESTRICTIVE write policies now require an org administrator or the
    platform; a supervisor may grant only WORKER/FAMILY. No app code wrote
    these tables as app_runtime (all writes are SECURITY DEFINER functions).
  - access_invitations.staff_role (ORGANIZATION_ADMIN | SUPERVISOR) for type
    organization_admin; trigger defaults to ORGANIZATION_ADMIN; only org admins
    or the platform may read/create/change these rows. Activation grants
    staff_role; inspection shows "Supervisor de la organización".
  - Rates, timesheets and pay periods: RESTRICTIVE admin-only policies.
- New module team: GET /organizations/:id/team, POST .../team/invitations
  {email, role}, POST .../team/invitations/:id/revoke — ORGANIZATION_ADMIN only.
- Timesheet and pay-period services require app_is_org_admin(); pay-period
  routes now return 403 (was 500) when forbidden.
- Verification: scripts/verifyTeamAndAdminAuthority.ts 28/28 in CI.
- Limitation: inviting an email that already has an ETNARA account is not
  supported yet (ACCOUNT_ALREADY_EXISTS, unchanged activation behavior).

## 2026-10-22 — Agency plain language (fix/agency-plain-language)

- Planning and coverage texts use real Spanish plurals instead of "(s)"/"(es)".
- Operational alerts name the resident by preferred name when set
  (COALESCE(preferred_name, first + last)), matching the agency screens.
- Test: tests/fixAgencyPlainLanguage.test.ts. No migration or API-shape change.

## 2026-10-22 — Coverage truth + alert time (fix/coverage-truth-and-alert-time)

- Workforce planning counts a shift as covered only with an ACCEPTED
  assignment (same rule as operations.service `!shift.accepted`). Texts now say
  "cuidador confirmado".
- Operational alert detail formats the shift start in America/Puerto_Rico
  without seconds (`formatShiftStart`); Railway runs in UTC, so the old
  `toLocaleString("es-PR")` showed times 4 hours off.
- Test: tests/fixCoverageTruthAndAlertTime.test.ts. No migration, no RLS change.
- Pairs with ETNARAMVP fix/agency-coverage-compliance-truth.

## 2026-10-21 — Phase 12.0 offline-safe care events (gate/12.0-offline-safe-care-events)

- Migration 083 (renumbered from 080 to avoid a clash) adds nullable `care_events.client_event_id` with a partial
  unique index on (organization_id, organization_worker_membership_id,
  client_event_id). Additive only; RLS policies unchanged.
- POST care-events accepts optional `clientEventId` and `occurredAt`. A retry
  returns the stored row (200, `replayed: true`) before the active-visit guard;
  concurrent retries resolve through ON CONFLICT DO NOTHING; no duplicate
  family notification. `occurredAt` must be at or after the active check-in and
  no more than 2 minutes in the future. Reusing an id for another record is 409.
- After check-out the shift is invisible to the worker (076), so the app must
  deliver pending records before letting the caregiver finish the visit.
- FOUND AND FIXED (migration 081): 076 made app_worker_has_shift_assignment read
  shifts and verification_events, whose worker policies call the same helper.
  Under app_runtime this recursed until PostgreSQL killed the backend (signal 9)
  and restarted the whole server when a caregiver accepted a shift. 081 keeps
  the 076 body verbatim and makes the helper SECURITY DEFINER with a fixed
  search_path (same pattern as 079).
- FOUND, NOT FIXED: accepting an assignment logs "messaging synchronization
  failed: could not determine data type of parameter $4" in
  syncAssignedWorkerConversationAccess; the acceptance succeeds but the worker
  may not be added to the recipient conversation.
- Validation on fresh PostgreSQL 16: bootstrap x2, tenant isolation, platform
  PHI boundary, invitation activation, new verifyCareEventIdempotency (17/17),
  76 files / 250 tests, build and diff check pass.
- Exact next step: Rafa's gate PASS, then deploy; the Railway pre-deploy bootstrap applies 083 before
  the frontend offline queue ships.

## 2026-10-21 — Fix: caregiver never joined the recipient conversation (fix/assignment-messaging-sync)

- Accepting a shift logged "messaging synchronization failed: could not
  determine data type of parameter $4" from an untyped `${roomId} IS NOT NULL`.
- Root cause was deeper: message_threads_read only shows threads the user already
  participates in, so the accepting worker could never SELECT the thread to join.
  Even with the cast the INSERT…SELECT inserted 0 rows.
- The thread is now resolved with the existing SECURITY DEFINER helper
  app_find_family_thread_id() (migration 035); the INSERT stays under
  message_thread_participants_write (self only, authorized recipient only).
  No new privileged function, no RLS change.
- verifyAssignmentMessagingSync.ts: 3/6 before the fix, 7/7 after, including a
  direct RLS attack (joining an unassigned recipient's thread is rejected). Wired into CI.
- Regression: tenant isolation, platform PHI, invitations, 88 files / 272 tests,
  build and diff check pass.

Project: ETNARA Care
Repository: ETNARA-Backend
Branch: phase-10/10.0-multi-agency-compliance

## 2026-10-21 — Phase 12.1 recipient address and directions

- Migration 084 adds `care_recipient_locations` (address line, municipality,
  access notes, optional paired coordinates) in its own table so RLS controls
  the address independently of the recipient row.
- Managers (ORGANIZATION_ADMIN, SUPERVISOR) read and write. A worker reads only
  while `app_worker_has_recipient_assignment()` is true (assigned, not-ended
  shift or open visit) and never writes. Family members and platform
  administrators get no access. No DELETE grant; clearing is an UPDATE.
- A SECURITY DEFINER trigger rejects a location whose organization differs from
  its recipient's (CARE_RECIPIENT_LOCATION_ORG_MISMATCH).
- New routes: GET and PUT `/organizations/:organizationId/care-recipients/:recipientId/location`.
- Verification: `scripts/verifyRecipientLocationAccess.ts` (21/21, HTTP + RLS
  attacks) added to CI; the table is included in the platform PHI boundary.
- Exact next step: gate PASS from Rafa, then the frontend (agency edit fields,
  caregiver "Cómo llegar" card). Publish only after Railway returns and 084 is applied.

## 2026-09-27 — Phase 10.0 multi-agency establishments

- Reuses the existing organization tenant and locations hierarchy; no parallel
  agency or establishment model was created.
- A user may belong to multiple organizations, but every request operates
  against exactly one selected organization and always filters by its ID.
- Organization managers can list, create, edit, archive and reactivate their
  establishments. Physical deletion is unavailable and changes are audited.
- PostgreSQL RLS independently enforces tenant membership for reads and
  manager authority plus tenant identity for writes.
- No Puerto Rico regulatory requirement or automatic compliance rule was
  introduced in this phase.
- Exact next step: complete local validation, publish the coordinated PRs,
  merge only after CI passes, and verify Railway before the frontend deploy.

## 2026-09-26 — Phase 9.4 B2B Agent Center stability close

- Preserved Operations, Compliance, Coverage and Care Quality as independent
  manager-only contracts with their own immutable audit records.
- The coordinated Agent Center is intentionally a frontend composition and
  introduces no duplicate backend decision engine or aggregate data contract.
- Family remains outside every organization-wide briefing and no regulatory
  requirement was added or inferred.
- Added dedicated Phase 7.9 regression coverage for manager authority,
  organization isolation, immutable pay-period snapshots and exception gates.
- Published and merged in backend PR #57 after TypeScript, all 106 tests,
  build, CI and PostgreSQL 16 validation passed.

## 2026-09-26 — Phase 9.3 assisted Care Quality Agent

- Added a manager-requested quality briefing derived from completed shifts,
  verification events, configured required care events, open observations and
  incidents without documented follow-up.
- The agent ranks at most five objective documentation gaps and opens the
  existing human workflow without modifying any care record.
- Each run records organization-scoped counts and priority keys in immutable
  manager-only history. Family receives no route or contract.
- No external model receives data, and the agent cannot create/edit notes,
  review observations, resolve incidents or make clinical conclusions.
- Published and merged in backend PR #56 after TypeScript, all 104 tests,
  build, PostgreSQL 16 validation and CI passed; Railway serves the protected
  quality-agent route.

## 2026-09-26 — Phase 9.2 assisted Coverage Agent

- Added a manager-requested coverage briefing for real uncovered shifts in the
  next seven days.
- The agent reuses fresh coverage recommendations, reads the latest staged
  campaign and ranks at most five shifts by urgency and current response state.
- Recommendations open the existing shift workflow; no offer, assignment,
  cancellation, eligibility change or campaign mutation occurs automatically.
- Each run records organization-scoped counts and priority shift IDs in
  immutable manager-only history. Family receives no route or contract.
- Published and merged in backend PR #55 after 100/100 tests, build, PostgreSQL
  16 validation and CI passed; Railway serves the protected agent route.

## 2026-09-26 — Phase 9.1 assisted Compliance Agent

- Added a manager-requested compliance briefing using fresh eligibility,
  platform/organization verification state and real 30-day expirations.
- The agent ranks at most five active caregivers, explains blockers and opens
  the existing profile or policy workflow without changing any record.
- Each run records organization-scoped counts and priority membership IDs in
  immutable manager-only history.
- Family receives no route. No external model receives data, and the agent
  cannot approve/reject credentials, change eligibility, activate workers,
  upload documents or modify policy.
- Published and merged in backend PR #54 after 96/96 tests, build, PostgreSQL
  16 validation and CI passed; Railway serves the protected agent route.

## 2026-09-26 — Phase 9.0 assisted Operations Agent

- Added a manager-requested advisory briefing derived only from the real
  Phase 8.0 operational center.
- The agent ranks at most five current priorities, explains each reason and
  recommends the existing human workflow without performing the action.
- Every run is organization-scoped and immutably audited with its counts and
  priority alert keys; only managers can read the history.
- No data is sent to an external model. Family receives no route, and the
  agent cannot assign/cancel shifts, approve records or make clinical decisions.
- Published and merged in backend PR #53 after 92/92 tests, build, PostgreSQL
  16 validation and CI passed; Railway serves the protected agent route.

## 2026-09-26 — Phase 8.0 agency operations and automation

- Added a manager-only center derived from real shifts, verification events,
  credentials, incidents and timesheets.
- Alerts cover uncovered shifts, missed check-ins, expiring credentials,
  unresolved incidents and hours requiring review.
- Escalation revalidates the source, is idempotent and auditable, and notifies
  active Supervisors without making the underlying decision automatically.
- Published and merged in backend PR #52 after 88/88 tests, build, PostgreSQL
  16 validation and CI passed; Railway serves the protected endpoint.

## 2026-09-22 — Phase 7.8 timesheets, billing and payroll preparation

- A completed, accepted shift now produces one idempotent timesheet from its
  paired check-in and check-out. Workers cannot insert financial records or
  read rates directly.
- Organization managers can configure hourly worker-pay and agency-bill rates,
  review recorded time, approve it or dispute it with an explanation.
- Approved totals use integer cents and a frozen rate snapshot, so later rate
  changes do not rewrite history. Approved records cannot be reopened.
- Rate changes and every timesheet decision are recorded in the append-only
  audit log; all financial data remains organization-scoped and unavailable to
  Family.
- This phase calculates preparation totals only. ETNARA does not move money,
  execute payroll or issue invoices.
- Backend TypeScript build and all 85 tests pass locally.
- Exact next step: validate migration 058 on PostgreSQL 16, review the final
  diff and publish with the frontend only after explicit authorization.

## 2026-09-22 — Phase 7.7 planning runtime hotfix

- Fixed the live forecast query by explicitly casting all planning-horizon
  parameters to PostgreSQL `integer` before date arithmetic.
- Preserved the existing manager authorization, tenant context, eligibility
  rules and read-only planning behavior.
- Added a regression that requires every date-arithmetic horizon parameter to
  remain explicitly typed.
- Backend PR #48 was merged after TypeScript, build, all 80 tests, PostgreSQL
  validation and diff-safety checks passed.
- Railway remains healthy and serves the forecast route behind authentication.
- Exact next step: validate one authenticated live forecast from Administration.

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

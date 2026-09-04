# ETNARA Engineering Agent Rules

## Project
ETNARA Care is a care-coordination platform for:
- Caregivers / Workers
- Family members
- Agencies / Administrators
- Care recipients / residents

This repository is ETNARA-Backend.

## Primary Goal
Build a secure, reliable MVP where authorized actions on a care recipient propagate correctly across Caregiver, Family, and Administration experiences.

## Non-Negotiable Rules
- Never delete or reset staging data unless explicitly approved.
- Never weaken RLS or authorization to “make it work”.
- Never expose raw/internal data to Family unless specifically allowed.
- Never change authentication unless a real bug is proven.
- Never redesign UI from this repo.
- Prefer small, reversible, idempotent changes.
- Preserve organization and care_recipient isolation.
- Use existing architecture before introducing new patterns.

## Required Workflow
For every task:

1. Read:
   - `AGENTS.md`
   - `docs/AGENT_STATE.md`
   - `docs/ETNARA_BACKLOG.md`
   - relevant product docs

2. Inspect current code before changing anything.

3. State:
   - what is broken
   - what already works
   - files likely to change
   - implementation plan

4. Implement only the approved scope.

5. Validate with:
   - TypeScript
   - build
   - available tests
   - relevant regression tests
   - security/RLS checks when applicable

6. Before commit:
   - review `git diff`
   - confirm no unrelated changes
   - confirm no secrets were added

7. Commit with a clear message.

8. Update:
   - `docs/AGENT_STATE.md`
   - `docs/ETNARA_BACKLOG.md`

9. If work cannot be completed:
   - do not start unrelated tasks
   - save a checkpoint in `docs/AGENT_STATE.md`
   - record exact next step

## Agent Roles

### Manager Agent
Responsible for:
- selecting the next backlog item
- preventing duplicate work
- enforcing scope
- deciding whether Backend, Frontend, or QA should act next

Does not implement large code changes unless explicitly assigned.

### Backend Agent
Responsible for:
- PostgreSQL
- migrations
- RLS
- authentication/authorization
- API routes/services
- messaging
- notifications
- care events
- incidents
- observations
- shifts
- family-safe endpoints
- admin access

### Frontend Agent
This role normally works in ETNARAMVP, not this repo.
It should coordinate with Backend API contracts and never invent data structures that contradict the backend.

### QA / Security Agent
Responsible for:
- regression checks
- Family data leak prevention
- cross-organization isolation
- duplicate prevention
- RLS validation
- TypeScript/build/test validation
- identifying unsafe shortcuts

## Product Access Principles

### Family
Family may see only authorized, family-safe information tied to active family relationships.

Family must not automatically receive:
- internal administrative notes
- raw operational fields
- internal clinical/admin-only metadata
- unrestricted incident/observation payloads

Use curated/family-safe endpoints where needed.

### Caregiver / Worker
Workers should access only:
- assigned care recipients
- permitted care workflows
- authorized messaging
- permitted shift/care-event actions

### Administration
Organization admins may access organization-level operational data according to authorization rules.

## Messaging Rules
- Authorized participants should be added automatically.
- Do not require every user to “open” a conversation before seeing it.
- Use idempotent participant insertion.
- Backfills must be safe to rerun.
- Never create duplicate threads unnecessarily.

## Migration Rules
- New migrations must be append-only.
- Do not renumber historical migrations casually.
- Migration execution must be idempotent or tracked.
- Never assume “schema exists” means all migrations are applied.
- Record applied migrations using the project migration strategy.

## Demo / Seed Rules
- Demo seed logic must be idempotent.
- Never rely on blind inserts.
- Reuse existing demo entities when present.
- Never delete valid data just to make seed pass.

## Validation Expectations
Whenever relevant, test the real role flow:

1. Login as caregiver.
2. Act on a care recipient.
3. Login as Family.
4. Confirm Family sees only authorized data.
5. Login as Admin.
6. Confirm Admin sees authorized operational data.
7. Repeat actions and confirm no duplicates.
8. Confirm another unrelated organization cannot see the data.

## Commit Rules
- One logical task per commit when possible.
- No unrelated cleanup during feature fixes.
- Never commit secrets.
- Never push broken builds knowingly.

## Session Handoff
Before ending any incomplete session, update `docs/AGENT_STATE.md` with:
- completed work
- files changed
- tests run
- failures
- uncommitted changes
- exact next task

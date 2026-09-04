# ETNARA Backlog

## In Progress

### ETN-001 — Recover previous backend work
Goal:
Verify whether the uncommitted backend changes from the previous agent session still exist.

Acceptance criteria:
- git status reviewed
- git diff reviewed
- migrations 038/039 verified
- previous messaging / notifications / family-safe endpoint work confirmed or marked missing
- AGENT_STATE updated

---

## Next

### ETN-002 — Backend review and security validation
- TypeScript
- build
- tests
- code review
- security / RLS review
- Family leak regression

### ETN-003 — Commit and push backend
- commit only verified backend changes
- push to main or approved branch
- confirm Railway deployment

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

---

## Rules

- Work on one backlog item at a time.
- Do not silently expand scope.
- Update AGENT_STATE after each task.
- Mark items complete only after validation.
- If a session ends early, preserve the exact next step.

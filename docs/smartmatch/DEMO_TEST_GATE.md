# SmartMatch — Demo agency verification gate

SmartMatch demo is **not deployed**. Backend PR #179 and frontend PR #203 are draft.

## Environment gate (mandatory)
Railway project `hopeful-education` currently exposes only the environment named `production`. Services named `etnara-care-backend-staging` and `etnara-care-staging-db` are within that production environment. Service names alone do not prove isolation.

Do not apply migrations 078–080, merge, or switch the production service source branch merely to run this demo. First provision/verify an isolated nonproduction environment and database, with only synthetic users and synthetic opportunities.

## Verification sequence
1. Back up or snapshot the isolated database and verify its connection target.
2. Apply migrations 078, 079, 080 on the isolated database and inspect grants, FORCE RLS, and policy behavior as `app_runtime` (not the table owner).
3. Seed two **synthetic** active agencies A and B with different organization admins. Never reuse real patient records.
4. Authenticate admin A, create an INTERNAL draft, list it, publish it. Verify admin B cannot read or update A's opportunity even if the UUID is known.
5. Verify non-admin A and platform administration cannot list, create, or publish agency opportunities.
6. Verify an invalid date range and NETWORK publication are rejected.
7. Verify no patient name, exact address, or clinical fields appear in any response. Validate caregiver-location and application tables remain inaccessible.
8. Open frontend PR #203 preview against this isolated backend, select agency A/B, confirm the UI refetches on org switch and never shows stale A records while B is selected.
9. Verify API, database, and frontend tests; record observed outcomes, not assumptions.

## Not yet supported
- Caregiver opportunity discovery, 25-minute routing, consent-based saved location, applications, eligibility and transactional approval are not implemented as integrated endpoints.
- The current published opportunity is **metadata only**, not yet linked to an actual shift/patient.
- CI green is not equivalent to a PostgreSQL RLS integration test.

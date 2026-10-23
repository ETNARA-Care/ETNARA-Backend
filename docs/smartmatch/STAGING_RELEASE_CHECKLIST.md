# SmartMatch — staging release checklist (2026-10-22)

## Confirmed
- User confirmed five concurrent changes completed; previous hold cleared.
- Backend PR #179 and frontend PR #203 have successful branch CI evidence for backend, but remain unmerged.
- Isolated Railway project: `etnara-document-security-staging` (`b829c0bd-43a3-4458-82b3-c4650b840173`); environment `staging` (`651dd762-08c1-4674-97de-d11869579df1`).
- Independent PostgreSQL service: `50b365eb-4ecd-4cfc-8845-ab1bcc0f9ba3`.
- Existing staging API: `23f0b637-c226-4360-9d9d-9b9735ab0c21`, currently sourced from agency-document security audit branch, **not** SmartMatch.
- Production Railway project `hopeful-education` must remain untouched.
- Branch `feat/smartmatch-phase1-foundation` has diverged from main. Do not deploy this branch against a schema assumed to match main without checking migrations.

## Blocking issues to resolve before a working demo
1. Compare main's current migration ledger with SmartMatch migrations `090`–`093`; rename/sequence conflicting numbers safely. Migration `082` belongs to agency-document PR #187.
2. Verify isolated staging PostgreSQL schema initialization and runtime role `app_runtime` credentials. Existing staging backend was reporting PostgreSQL `42883` for `app_advance_due_coverage_campaigns()`, consistent with missing function/schema.
3. Review branch divergence and integrate only reviewed SmartMatch changes with the latest main, avoiding unreviewed overwrites.
4. Apply vetted migrations to **isolated** PostgreSQL, verify grants and RLS as runtime role, and seed only fictional agency A and agency B.
5. Configure a **separate** SmartMatch staging backend service from a validated integration branch, with no production database connection and no automatic bootstrap applying unreviewed migrations.
6. Deploy frontend PR #203 preview connected only to SmartMatch staging API. Verify authenticated agency switching, create/list/publish and read-only pending application queue.
7. Exercise negative authorization tests (agency B cannot access A; ETNARA platform admin cannot access agency private data); verify no patient or exact-address fields.
8. Only then share a usable mobile demo URL and mark the pilot ready.

## Explicitly not ready
- Caregiver application submission, real driving-time routing, verified credential matching, transactional approval and assignment.
- The current backend source in isolated staging does not serve SmartMatch endpoints.
- Railway SUCCESS alone does not imply the demo works.

Do not change production or publish an untested demo link.

-- SmartMatch RLS smoke test: run ONLY against isolated synthetic-data PostgreSQL.
-- Requires migrations 078-080 and two active agencies with admin users.
-- Example: psql -v agency_a=... -v agency_b=... -v admin_a=... -v admin_b=... -v opportunity_a=... -f scripts/smartmatch_rls_demo_smoke.sql
-- All variables must refer to synthetic fixture UUIDs.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_a', true);
SELECT set_config('app.current_org_id', :'agency_a', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT 1 / (CASE WHEN EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE id = :'opportunity_a'::uuid
) THEN 1 ELSE 0 END) AS agency_a_own_row_required;
SELECT 1 / (CASE WHEN NOT EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE organization_id = :'agency_b'::uuid
) THEN 1 ELSE 0 END) AS agency_a_cannot_read_b;
ROLLBACK;

BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_b', true);
SELECT set_config('app.current_org_id', :'agency_b', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT 1 / (CASE WHEN NOT EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE id = :'opportunity_a'::uuid
) THEN 1 ELSE 0 END) AS agency_b_cannot_read_a;
ROLLBACK;

-- Any failed assertion raises division_by_zero and ON_ERROR_STOP aborts the script.
-- Manual gate: any failed assertion blocks deployment. Also verify UPDATE RETURNING 0 rows,
-- non-admin 403, and denied application/location grants before approval.

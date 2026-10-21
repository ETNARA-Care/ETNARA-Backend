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
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE id = :'opportunity_a'::uuid
) THEN 'PASS: A can read own opportunity' ELSE 'FAIL: A cannot read own opportunity' END AS own_visibility;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE organization_id = :'agency_b'::uuid
) THEN 'PASS: A cannot read B' ELSE 'FAIL: A can read B' END AS cross_tenant_visibility;
ROLLBACK;

BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_b', true);
SELECT set_config('app.current_org_id', :'agency_b', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM smartmatch_opportunities WHERE id = :'opportunity_a'::uuid
) THEN 'PASS: B cannot read A' ELSE 'FAIL: B can read A' END AS cross_tenant_visibility;
ROLLBACK;

-- Manual gate: any FAIL blocks deployment. Also verify UPDATE RETURNING 0 rows,
-- non-admin 403, and denied application/location grants before approval.

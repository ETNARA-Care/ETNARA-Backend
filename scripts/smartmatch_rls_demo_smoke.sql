-- SmartMatch: database-backed tenant isolation checks.
-- Run ONLY on an isolated synthetic-data PostgreSQL database after migrations 078-080.
-- Use an app_runtime connection/SET ROLE, not the table owner.
-- Supply real synthetic IDs in psql variables before running:
--   \set agency_a '...'
--   \set agency_b '...'
--   \set admin_a '...'
--   \set admin_b '...'
--   \set opportunity_a '...'
-- IDs must reference two different active organizations with active admin memberships.
-- This script aborts on the first failed assertion.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_a', true);
SELECT set_config('app.current_org_id', :'agency_a', true);
SELECT set_config('app.is_superadmin', 'false', true);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM smartmatch_opportunities WHERE organization_id = current_setting('app.current_org_id')::uuid) < 1 THEN
    RAISE EXCEPTION 'Agency A should see its own synthetic opportunity';
  END IF;
END $$;
SELECT CASE WHEN COUNT(*) = 0 THEN 'PASS: agency A cannot see B'
  ELSE (1/0)::text END AS isolation
FROM smartmatch_opportunities WHERE organization_id = :'agency_b'::uuid;

-- Even if the UUID is known, agency A must not be able to update B's opportunity.
UPDATE smartmatch_opportunities SET status = status
WHERE id = :'opportunity_a'::uuid AND organization_id = :'agency_b'::uuid;
ROLLBACK;

-- Agency B sees no A rows under its own context.
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_b', true);
SELECT set_config('app.current_org_id', :'agency_b', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT CASE WHEN COUNT(*) = 0 THEN 'PASS: agency B cannot see A'
  ELSE (1/0)::text END AS isolation
FROM smartmatch_opportunities WHERE organization_id = :'agency_a'::uuid;
ROLLBACK;

-- NOTE: For a complete verification, also assert UPDATE ... RETURNING returns
-- zero rows, non-admin access is denied, and app_runtime cannot SELECT
-- applications/location preferences. Do not treat this partial SQL as signoff.

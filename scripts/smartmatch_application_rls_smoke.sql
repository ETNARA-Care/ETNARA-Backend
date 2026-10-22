-- SmartMatch application visibility checks against synthetic fixture data only.
-- Expected fixture: one application on Agency A opportunity.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_a', true);
SELECT set_config('app.current_org_id', :'agency_a', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT 1 / (CASE WHEN EXISTS (
 SELECT 1 FROM smartmatch_applications WHERE opportunity_id = :'opportunity_a'::uuid
) THEN 1 ELSE 0 END) AS agency_a_can_review_own_applications;
ROLLBACK;
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', :'admin_b', true);
SELECT set_config('app.current_org_id', :'agency_b', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT 1 / (CASE WHEN NOT EXISTS (
 SELECT 1 FROM smartmatch_applications WHERE opportunity_id = :'opportunity_a'::uuid
) THEN 1 ELSE 0 END) AS agency_b_cannot_review_a_applications;
ROLLBACK;
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.current_user_id', '77777777-7777-4777-8777-777777777777', true);
SELECT set_config('app.current_org_id', :'agency_a', true);
SELECT set_config('app.is_superadmin', 'false', true);
SELECT 1 / (CASE WHEN NOT EXISTS (
 SELECT 1 FROM smartmatch_applications WHERE opportunity_id = :'opportunity_a'::uuid
) THEN 1 ELSE 0 END) AS nonmember_cannot_review_applications;
ROLLBACK;

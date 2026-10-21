-- SmartMatch privileges: run against ISOLATED PostgreSQL after migrations 078-080.
-- This script does not modify data. Fail closed on unexpected privileges.
\set ON_ERROR_STOP on
SELECT 1 / (CASE WHEN
  has_table_privilege('app_runtime', 'smartmatch_opportunities', 'SELECT')
  AND has_table_privilege('app_runtime', 'smartmatch_opportunities', 'INSERT')
  AND has_table_privilege('app_runtime', 'smartmatch_opportunities', 'UPDATE')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_opportunities', 'DELETE')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_applications', 'SELECT')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_applications', 'INSERT')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_applications', 'UPDATE')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_applications', 'DELETE')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_location_preferences', 'SELECT')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_location_preferences', 'INSERT')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_location_preferences', 'UPDATE')
  AND NOT has_table_privilege('app_runtime', 'smartmatch_location_preferences', 'DELETE')
THEN 1 ELSE 0 END) AS smartmatch_least_privilege_gate;

SELECT 1 / (CASE WHEN
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'smartmatch_opportunities'::regclass)
  AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'smartmatch_applications'::regclass)
  AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'smartmatch_location_preferences'::regclass)
THEN 1 ELSE 0 END) AS smartmatch_rls_forced_gate;

-- This checks explicit/inherited SQL grants and RLS configuration, not
-- runtime policy correctness. Execute the cross-agency fixture test separately.

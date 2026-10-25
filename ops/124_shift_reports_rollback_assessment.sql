-- READ-ONLY assessment before rolling back migration 124 (Informe de Turno F1). Changes nothing.
-- Run it as the owner:
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f ops/124_shift_reports_rollback_assessment.sql
-- Output is counts only: never names, report content, notes or ids.
--
-- What a rollback would lose: ONLY the reports and their history. The records the
-- reports were built from (arrivals, check-in/out, care events, incidents,
-- observations) are never written by this module and stay as they are.
-- Recommended path when something is wrong: turn SHIFT_REPORTS off for the agency
-- (ETNARA central) and fix forward; keep 124. Roll back only when every count is 0.

BEGIN TRANSACTION READ ONLY;

SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '124_shift_reports.sql') AS migration_124_applied,
       to_regclass('public.shift_reports') IS NOT NULL AS table_present;

SELECT
  (SELECT count(*) FROM shift_reports) AS reports,
  (SELECT count(*) FROM shift_reports WHERE status IN ('APPROVED', 'SUPERSEDED')) AS approved_reports,
  (SELECT count(*) FROM shift_report_events) AS history_rows,
  (SELECT count(*) FROM shift_report_reviewers) AS reviewer_grants,
  (SELECT count(DISTINCT organization_id) FROM shift_reports) AS agencies_with_reports,
  (SELECT count(*) FROM organization_features WHERE feature_code = 'SHIFT_REPORTS') AS feature_rows,
  (SELECT count(*) FROM organization_features WHERE feature_code = 'SHIFT_REPORTS' AND enabled) AS agencies_enabled,
  (SELECT count(*) FROM organization_feature_events WHERE feature_code = 'SHIFT_REPORTS') AS feature_history_rows;

ROLLBACK;

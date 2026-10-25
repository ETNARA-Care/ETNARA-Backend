-- Rollback of migration 124 (Informe de Turno F1). Run as the owner, ONLY after
-- ops/124_shift_reports_rollback_assessment.sql returns 0 for every count and the
-- backend is back on a version without the shift-report routes.
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f ops/124_shift_reports.rollback.sql
-- It aborts (and changes nothing) when any report, history row or SHIFT_REPORTS
-- switch row exists: those are real data, and the switch history is kept by design.
-- Original records (arrivals, check-in/out, care events, incidents, observations)
-- are not touched in either direction.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.shift_reports') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM shift_reports) OR EXISTS (SELECT 1 FROM shift_report_events) THEN
      RAISE EXCEPTION 'shift reports exist: rollback aborted (turn SHIFT_REPORTS off and fix forward)';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM organization_features WHERE feature_code = 'SHIFT_REPORTS')
     OR EXISTS (SELECT 1 FROM organization_feature_events WHERE feature_code = 'SHIFT_REPORTS') THEN
    RAISE EXCEPTION 'SHIFT_REPORTS switch history exists: rollback aborted (turn it off and fix forward)';
  END IF;
END $$;

DROP TABLE IF EXISTS shift_report_events;
DROP TABLE IF EXISTS shift_reports;
DROP FUNCTION IF EXISTS app_shift_report_events_append_only();
DROP FUNCTION IF EXISTS app_shift_report_guard();

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION'));

DELETE FROM schema_migrations WHERE filename = '124_shift_reports.sql';

COMMIT;

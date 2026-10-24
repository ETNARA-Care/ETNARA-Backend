-- ROLLBACK of migration 118 (ETNARA Finanzas F0 — safe financial foundation).
-- Run ONLY as the database owner, in one go, and only if FINANZAS was never
-- turned on. A code-only rollback does NOT need it: the previous backend never
-- reads finance_events, and the policies and triggers below only narrow access.
--
-- Stops, changing nothing, if any agency has the FINANZAS switch row or any
-- finance_events row exists (the history would be lost).
-- 058, 059, 085 and 114 are not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_features WHERE feature_code = 'FINANZAS')
     OR EXISTS (SELECT 1 FROM organization_feature_events WHERE feature_code = 'FINANZAS') THEN
    RAISE EXCEPTION 'FINANZAS switch rows exist: rollback aborted, nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM finance_events) THEN
    RAISE EXCEPTION 'finance_events rows exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS pay_period_timesheets_immutable ON pay_period_timesheets;
DROP FUNCTION IF EXISTS public.app_pay_period_link_immutable();
DROP TRIGGER IF EXISTS timesheets_approved_immutable ON timesheets;
DROP FUNCTION IF EXISTS public.app_timesheet_approved_immutable();

DROP POLICY IF EXISTS platform_finance_deny ON timesheets;
DROP POLICY IF EXISTS platform_finance_deny ON worker_financial_rates;
DROP POLICY IF EXISTS platform_finance_deny ON pay_periods;
DROP POLICY IF EXISTS platform_finance_deny ON pay_period_timesheets;

DROP TABLE IF EXISTS finance_events;
DROP FUNCTION IF EXISTS public.app_finance_events_append_only();

-- Re-opening financial audit rows to every member and to ETNARA central is
-- the H-01 exposure; only drop this policy if that is really intended.
DROP POLICY IF EXISTS audit_log_financial_admin_only ON audit_log;
DROP FUNCTION IF EXISTS public.app_is_financial_audit_action(text);

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS'));

DELETE FROM schema_migrations WHERE filename = '118_finance_foundation.sql';

COMMIT;

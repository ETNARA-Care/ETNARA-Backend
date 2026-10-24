-- Migration 118: ETNARA Finanzas F0 — safe financial foundation.
--
-- Prepares the existing financial tables (058, 059) for invoicing (F1-F4)
-- without touching the check-out path: app_record_timesheet_from_checkout
-- (058 -> 114) is NOT replaced and keeps its grants.
--
--  1. FINANZAS per-agency switch, off for every agency (108 pattern). Only
--     ETNARA central turns it on; it never sees the data behind it.
--  2. audit_log: rows of financial actions are readable only by the agency's
--     ORGANIZATION_ADMIN. Before this, any active member (caregivers
--     included) and ETNARA central could read pay and bill rates and amounts
--     stored in previous_value/new_value (finding H-01, confirmed by
--     execution). Existing rows are NOT modified: they are hidden.
--  3. finance_events: append-only financial history with the values, admin
--     only, per agency. The backend stops writing amounts into audit_log.
--  4. Explicit RESTRICTIVE deny for ETNARA central on every financial table
--     (085 already limits them to ORGANIZATION_ADMIN; this closes the
--     platform session too, as 078 does for PHI).
--  5. An approved timesheet is immutable in the database, for the owner too
--     (H-03): PRODUCT_RULES already said so, only the service enforced it.
--     Pay-period links are immutable as well.
--
-- No existing data is modified. Rollback: ops/118_finance_foundation.rollback.sql

-- 1. Switch -------------------------------------------------------------------
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS'));

-- 2. Financial rows of audit_log: admin of the agency only --------------------
CREATE OR REPLACE FUNCTION public.app_is_financial_audit_action(p_action text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_action IN (
           'WORKER_FINANCIAL_RATE_CHANGED', 'TIMESHEET_CREATED', 'TIMESHEET_APPROVED',
           'TIMESHEET_DISPUTED', 'TIMESHEET_SKIPPED_LONG_VISIT', 'PAY_PERIOD_CLOSED')
      OR p_action LIKE 'FINANCE\_%'
$$;
REVOKE ALL ON FUNCTION public.app_is_financial_audit_action(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_financial_audit_action(text) TO app_runtime;

-- SELECT only: inserts (the service and SECURITY DEFINER functions) are unchanged.
DROP POLICY IF EXISTS audit_log_financial_admin_only ON audit_log;
CREATE POLICY audit_log_financial_admin_only ON audit_log
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (NOT public.app_is_financial_audit_action(action)
         OR (public.app_is_org_admin() AND NOT app_is_superadmin()));

-- 3. finance_events -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_user_id   uuid NOT NULL REFERENCES users(id),
  action          text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  entity_type     text NOT NULL CHECK (length(btrim(entity_type)) BETWEEN 1 AND 80),
  entity_id       uuid NOT NULL,
  previous_value  jsonb NULL,
  new_value       jsonb NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_events_org_time ON finance_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_events_entity ON finance_events (organization_id, entity_type, entity_id, occurred_at DESC);

ALTER TABLE finance_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finance_events_admin_read ON finance_events;
CREATE POLICY finance_events_admin_read ON finance_events
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_is_org_admin());

DROP POLICY IF EXISTS finance_events_admin_insert ON finance_events;
CREATE POLICY finance_events_admin_insert ON finance_events
  FOR INSERT TO app_runtime
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND public.app_is_org_admin());

REVOKE ALL ON finance_events FROM app_runtime;
GRANT SELECT, INSERT ON finance_events TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_finance_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'finance_events is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS finance_events_append_only ON finance_events;
CREATE TRIGGER finance_events_append_only
  BEFORE UPDATE OR DELETE ON finance_events
  FOR EACH ROW EXECUTE FUNCTION public.app_finance_events_append_only();
DROP TRIGGER IF EXISTS finance_events_no_truncate ON finance_events;
CREATE TRIGGER finance_events_no_truncate
  BEFORE TRUNCATE ON finance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.app_finance_events_append_only();

-- 4. ETNARA central: explicit deny on every financial table ---------------------
DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'timesheets', 'worker_financial_rates', 'pay_periods', 'pay_period_timesheets', 'finance_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_finance_deny ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY platform_finance_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())',
      target_table
    );
  END LOOP;
END $$;

-- 5. Immutability ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_timesheet_approved_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'TIMESHEET_IMMUTABLE' USING ERRCODE = '55000',
      DETAIL = 'An approved timesheet cannot be changed or deleted.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS timesheets_approved_immutable ON timesheets;
CREATE TRIGGER timesheets_approved_immutable
  BEFORE UPDATE OR DELETE ON timesheets
  FOR EACH ROW EXECUTE FUNCTION public.app_timesheet_approved_immutable();

CREATE OR REPLACE FUNCTION public.app_pay_period_link_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'PAY_PERIOD_LINK_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS pay_period_timesheets_immutable ON pay_period_timesheets;
CREATE TRIGGER pay_period_timesheets_immutable
  BEFORE UPDATE OR DELETE ON pay_period_timesheets
  FOR EACH ROW EXECUTE FUNCTION public.app_pay_period_link_immutable();

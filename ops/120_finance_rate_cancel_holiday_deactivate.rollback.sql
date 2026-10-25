-- ROLLBACK of migration 120 (ETNARA Finanzas F1.1 — cancel scheduled rates, deactivate holidays).
-- Run ONLY as the database owner, in one go. A code-only rollback does NOT need
-- it: the 119 backend ignores the new columns (it never cancels and never
-- deactivates). Stops, changing nothing, if any rate was cancelled or any holiday
-- deactivated: dropping those columns would bring a cancelled price or a removed
-- holiday back into force. 119 and its data are not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_rates WHERE cancelled_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM finance_holidays WHERE NOT active OR deactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cancelled rates or deactivated holidays exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP TRIGGER IF EXISTS finance_holidays_guard ON finance_holidays;
DROP FUNCTION IF EXISTS public.app_finance_holiday_guard();
REVOKE UPDATE (name, active, deactivated_at, deactivated_by_user_id, deactivation_reason, updated_by_user_id, updated_at)
  ON finance_holidays FROM app_runtime;
ALTER TABLE finance_holidays DROP CONSTRAINT IF EXISTS finance_holidays_deactivation_shape;
ALTER TABLE finance_holidays
  DROP COLUMN IF EXISTS active, DROP COLUMN IF EXISTS deactivated_at, DROP COLUMN IF EXISTS deactivated_by_user_id,
  DROP COLUMN IF EXISTS deactivation_reason, DROP COLUMN IF EXISTS updated_by_user_id, DROP COLUMN IF EXISTS updated_at;

REVOKE UPDATE (superseded_by_rate_id, superseded_previous_to, cancelled_at, cancelled_by_user_id, cancel_reason)
  ON finance_rates FROM app_runtime;

-- The 119 guard, verbatim.
CREATE OR REPLACE FUNCTION public.app_finance_rate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_unit text;
  v_overlap boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only the end of the window (and who ended it) can change, and only earlier.
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.service_id <> OLD.service_id
       OR NEW.rate_kind <> OLD.rate_kind OR NEW.scope <> OLD.scope
       OR NEW.billing_client_id IS DISTINCT FROM OLD.billing_client_id
       OR NEW.organization_worker_membership_id IS DISTINCT FROM OLD.organization_worker_membership_id
       OR NEW.day_type <> OLD.day_type OR NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency
       OR NEW.effective_from <> OLD.effective_from
       OR NEW.min_minutes IS DISTINCT FROM OLD.min_minutes OR NEW.rounding_minutes IS DISTINCT FROM OLD.rounding_minutes
       OR NEW.half_day_policy IS DISTINCT FROM OLD.half_day_policy
       OR NEW.half_day_amount_cents IS DISTINCT FROM OLD.half_day_amount_cents
       OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by_user_id <> OLD.created_by_user_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to) THEN
      RAISE EXCEPTION 'FINANCE_RATE_END_ONLY_EARLIER' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT unit INTO v_unit FROM public.finance_services
  WHERE id = NEW.service_id AND organization_id = NEW.organization_id;
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'FINANCE_SERVICE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF v_unit <> 'hour' AND (NEW.min_minutes IS NOT NULL OR NEW.rounding_minutes IS NOT NULL) THEN
    RAISE EXCEPTION 'FINANCE_RATE_RULE_NOT_FOR_UNIT' USING ERRCODE = '23514';
  END IF;
  IF v_unit <> 'day' AND NEW.half_day_policy IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_RATE_RULE_NOT_FOR_UNIT' USING ERRCODE = '23514';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  -- No two versions of the same line (service, kind, scope, target, day type)
  -- may cover the same day. Serialised per line so two administrators saving
  -- at the same moment cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', NEW.organization_id, NEW.service_id, NEW.rate_kind, NEW.scope,
              NEW.billing_client_id, NEW.organization_worker_membership_id, NEW.day_type), 119));
  SELECT EXISTS (
    SELECT 1 FROM public.finance_rates r
    WHERE r.organization_id = NEW.organization_id AND r.service_id = NEW.service_id
      AND r.rate_kind = NEW.rate_kind AND r.scope = NEW.scope AND r.day_type = NEW.day_type
      AND r.billing_client_id IS NOT DISTINCT FROM NEW.billing_client_id
      AND r.organization_worker_membership_id IS NOT DISTINCT FROM NEW.organization_worker_membership_id
      AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')
  ) INTO v_overlap;
  IF v_overlap THEN
    RAISE EXCEPTION 'FINANCE_RATE_OVERLAP' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.app_finance_rate_guard() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.app_finance_rate_guard() FROM PUBLIC;

ALTER TABLE finance_rates DROP CONSTRAINT IF EXISTS finance_rates_cancel_shape;
ALTER TABLE finance_rates DROP CONSTRAINT IF EXISTS finance_rates_superseded_by_fk;
ALTER TABLE finance_rates
  DROP COLUMN IF EXISTS superseded_by_rate_id, DROP COLUMN IF EXISTS superseded_previous_to,
  DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancelled_by_user_id, DROP COLUMN IF EXISTS cancel_reason;

DELETE FROM schema_migrations WHERE filename = '120_finance_rate_cancel_holiday_deactivate.sql';

COMMIT;

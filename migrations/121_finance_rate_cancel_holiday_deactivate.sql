-- Migration 121 — ETNARA Finanzas F1.1
--
-- 1. A price change scheduled for a future date can be CANCELLED before it
--    takes effect (reason required, admin only, FINANZAS on). The cancelled
--    version is kept (never deleted) and no longer counts; the version it had
--    closed is reopened to where it ended before. Nothing that is already in
--    force, or in the past, can be cancelled.
-- 2. A holiday added by mistake can be DEACTIVATED (reason required) and later
--    reactivated. Rows are never deleted.
--
-- Additive only: new nullable columns plus a default, a rewritten guard
-- function and a new holiday guard. Existing rows keep their meaning. shifts,
-- timesheets, worker_financial_rates and check-out are not touched.

-- 1. Rate versions: who closed whom, and cancellation ---------------------------------
ALTER TABLE finance_rates
  ADD COLUMN IF NOT EXISTS superseded_by_rate_id uuid NULL,
  ADD COLUMN IF NOT EXISTS superseded_previous_to date NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_rates_cancel_shape') THEN
    ALTER TABLE finance_rates ADD CONSTRAINT finance_rates_cancel_shape CHECK (
      (cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)
      AND (cancelled_at IS NULL) = (cancel_reason IS NULL)
      AND (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 300));
  END IF;
END $$;

-- Backfill: versions closed by a newer version before 121. createRate closes the
-- covering version and inserts the new one in the same transaction, so the new
-- version's created_at equals the old one's ended_at exactly. The window end the
-- old version had before (null unless it had been ended earlier) comes from its
-- last FINANCE_RATE_ENDED event before that moment.
ALTER TABLE finance_rates DISABLE TRIGGER finance_rates_guard;
UPDATE finance_rates r
SET superseded_by_rate_id = n.id,
    superseded_previous_to = (
      SELECT (e.new_value->>'effective_to')::date FROM finance_events e
      WHERE e.organization_id = r.organization_id AND e.entity_id = r.id AND e.action = 'FINANCE_RATE_ENDED'
        AND e.occurred_at < r.ended_at
      ORDER BY e.occurred_at DESC LIMIT 1)
FROM finance_rates n
WHERE r.superseded_by_rate_id IS NULL AND r.ended_at IS NOT NULL AND r.effective_to IS NOT NULL
  AND n.organization_id = r.organization_id AND n.service_id = r.service_id
  AND n.rate_kind = r.rate_kind AND n.scope = r.scope AND n.day_type = r.day_type
  AND n.billing_client_id IS NOT DISTINCT FROM r.billing_client_id
  AND n.organization_worker_membership_id IS NOT DISTINCT FROM r.organization_worker_membership_id
  AND n.effective_from = r.effective_to + 1
  AND n.created_at = r.ended_at;
ALTER TABLE finance_rates ENABLE TRIGGER finance_rates_guard;

-- Added after the backfill: a deferred constraint would leave pending checks
-- that block re-enabling the trigger in this same transaction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_rates_superseded_by_fk') THEN
    -- Deferred: the closing UPDATE runs just before the new version is inserted.
    ALTER TABLE finance_rates ADD CONSTRAINT finance_rates_superseded_by_fk
      FOREIGN KEY (superseded_by_rate_id) REFERENCES finance_rates (id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.app_finance_rate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_unit text;
  v_overlap boolean;
  v_today date := (now() AT TIME ZONE 'America/Puerto_Rico')::date;
  v_actor text := NULLIF(current_setting('app.current_user_id', true), '');
  v_cancelled public.finance_rates%ROWTYPE;
  v_restore date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- The content of a version never changes.
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
    -- A cancelled version is final.
    IF OLD.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_RATE_CANCELLED' USING ERRCODE = '55000';
    END IF;

    -- (a) Cancel a version that has not taken effect yet (only the cancel fields change).
    IF NEW.cancelled_at IS NOT NULL THEN
      IF NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
         OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
         OR NEW.superseded_by_rate_id IS DISTINCT FROM OLD.superseded_by_rate_id
         OR NEW.superseded_previous_to IS DISTINCT FROM OLD.superseded_previous_to THEN
        RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      IF OLD.effective_from <= v_today THEN
        RAISE EXCEPTION 'FINANCE_RATE_ALREADY_IN_FORCE' USING ERRCODE = '55000';
      END IF;
      IF v_actor IS NOT NULL AND NEW.cancelled_by_user_id::text <> v_actor THEN
        RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      NEW.cancelled_at := now();
      RETURN NEW;
    END IF;
    IF NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
    END IF;

    -- (b) Reopen: only the version closed by a version cancelled in this same
    --     transaction, and only back to where it ended before (never later than
    --     the cancelled version's own end, so later versions stay untouched).
    IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
       AND OLD.effective_to IS NOT NULL
       AND (NEW.effective_to IS NULL OR NEW.effective_to > OLD.effective_to) THEN
      IF OLD.superseded_by_rate_id IS NULL THEN
        RAISE EXCEPTION 'FINANCE_RATE_END_ONLY_EARLIER' USING ERRCODE = '55000';
      END IF;
      SELECT * INTO v_cancelled FROM public.finance_rates
      WHERE id = OLD.superseded_by_rate_id AND organization_id = OLD.organization_id;
      IF v_cancelled.id IS NULL OR v_cancelled.cancelled_at IS NULL OR v_cancelled.cancelled_at <> now() THEN
        RAISE EXCEPTION 'FINANCE_RATE_END_ONLY_EARLIER' USING ERRCODE = '55000';
      END IF;
      v_restore := CASE
        WHEN OLD.superseded_previous_to IS NULL THEN v_cancelled.effective_to
        WHEN v_cancelled.effective_to IS NULL THEN OLD.superseded_previous_to
        ELSE LEAST(OLD.superseded_previous_to, v_cancelled.effective_to) END;
      IF NEW.effective_to IS DISTINCT FROM v_restore
         OR NEW.superseded_by_rate_id IS NOT NULL OR NEW.superseded_previous_to IS NOT NULL THEN
        RAISE EXCEPTION 'FINANCE_RATE_REOPEN_INVALID' USING ERRCODE = '55000';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(
        concat_ws('|', NEW.organization_id, NEW.service_id, NEW.rate_kind, NEW.scope,
                  NEW.billing_client_id, NEW.organization_worker_membership_id, NEW.day_type), 119));
      SELECT EXISTS (
        SELECT 1 FROM public.finance_rates r
        WHERE r.id <> NEW.id AND r.cancelled_at IS NULL
          AND r.organization_id = NEW.organization_id AND r.service_id = NEW.service_id
          AND r.rate_kind = NEW.rate_kind AND r.scope = NEW.scope AND r.day_type = NEW.day_type
          AND r.billing_client_id IS NOT DISTINCT FROM NEW.billing_client_id
          AND r.organization_worker_membership_id IS NOT DISTINCT FROM NEW.organization_worker_membership_id
          AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')
      ) INTO v_overlap;
      IF v_overlap THEN
        RAISE EXCEPTION 'FINANCE_RATE_OVERLAP' USING ERRCODE = '23P01';
      END IF;
      RETURN NEW;
    END IF;

    -- (c) End earlier (also when a newer version closes this one).
    IF NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to) THEN
      RAISE EXCEPTION 'FINANCE_RATE_END_ONLY_EARLIER' USING ERRCODE = '55000';
    END IF;
    IF NEW.superseded_by_rate_id IS DISTINCT FROM OLD.superseded_by_rate_id
       OR NEW.superseded_previous_to IS DISTINCT FROM OLD.superseded_previous_to THEN
      -- Recorded once, and the "previous end" must be the real one.
      IF OLD.superseded_by_rate_id IS NOT NULL OR NEW.superseded_by_rate_id IS NULL
         OR NEW.superseded_previous_to IS DISTINCT FROM OLD.effective_to THEN
        RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancel_reason IS NOT NULL
     OR NEW.superseded_by_rate_id IS NOT NULL OR NEW.superseded_previous_to IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCE_RATE_IMMUTABLE' USING ERRCODE = '55000';
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

  -- No two live versions of the same line may cover the same day (cancelled
  -- versions do not count). Serialised per line.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', NEW.organization_id, NEW.service_id, NEW.rate_kind, NEW.scope,
              NEW.billing_client_id, NEW.organization_worker_membership_id, NEW.day_type), 119));
  SELECT EXISTS (
    SELECT 1 FROM public.finance_rates r
    WHERE r.organization_id = NEW.organization_id AND r.service_id = NEW.service_id
      AND r.cancelled_at IS NULL
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

GRANT UPDATE (superseded_by_rate_id, superseded_previous_to, cancelled_at, cancelled_by_user_id, cancel_reason)
  ON finance_rates TO app_runtime;

-- 2. Holidays: deactivate / reactivate, never delete -------------------------------------
ALTER TABLE finance_holidays
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deactivated_by_user_id uuid NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deactivation_reason text NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id uuid NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_holidays_deactivation_shape') THEN
    ALTER TABLE finance_holidays ADD CONSTRAINT finance_holidays_deactivation_shape CHECK (
      (active AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL AND deactivation_reason IS NULL)
      OR (NOT active AND deactivated_at IS NOT NULL AND deactivated_by_user_id IS NOT NULL
          AND length(btrim(deactivation_reason)) BETWEEN 3 AND 300));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.app_finance_holiday_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FINANCE_HOLIDAY_NO_DELETE' USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.holiday_date <> OLD.holiday_date
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FINANCE_HOLIDAY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- Only two transitions: active → inactive (with reason) and inactive → active
  -- (the name may be corrected when reactivating).
  IF NEW.active = OLD.active THEN
    RAISE EXCEPTION 'FINANCE_HOLIDAY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.active = false AND NEW.name <> OLD.name THEN
    RAISE EXCEPTION 'FINANCE_HOLIDAY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.active = false THEN
    NEW.deactivated_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.app_finance_holiday_guard() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.app_finance_holiday_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS finance_holidays_guard ON finance_holidays;
CREATE TRIGGER finance_holidays_guard
  BEFORE UPDATE OR DELETE ON finance_holidays
  FOR EACH ROW EXECUTE FUNCTION public.app_finance_holiday_guard();

GRANT UPDATE (name, active, deactivated_at, deactivated_by_user_id, deactivation_reason, updated_by_user_id, updated_at)
  ON finance_holidays TO app_runtime;

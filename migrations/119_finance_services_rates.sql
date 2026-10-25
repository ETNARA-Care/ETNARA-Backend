-- Migration 119: ETNARA Finanzas F1 — services and differentiated rates.
--
-- Each agency keeps its own catalogue of services and, per service, two
-- independent rate lines:
--   * client (billing) rates: general, or negotiated for one billing client;
--   * caregiver (pay) rates:  general, or an exception for one caregiver.
-- Every rate is a dated version (America/Puerto_Rico days). A version is never
-- edited: a new price closes the previous version and opens a new one, so
-- what was already provided keeps the price it had. Optional holiday rates use
-- the agency's own holiday calendar.
--
-- Shifts are NOT altered: the service, payer and authorised units of a shift
-- live in shift_finance_terms (admin only), so Turnos, SmartMatch, check-in,
-- check-out and app_record_timesheet_from_checkout are untouched.
--
-- Security (same model as 118): ORGANIZATION_ADMIN of the agency only, per
-- organization; ETNARA central denied (RESTRICTIVE); no DELETE; writes refused
-- while FINANZAS is off for the agency (defence in depth behind the route gate);
-- values only in finance_events, never in audit_log.
-- No existing data is read or modified. Rollback: ops/119_finance_services_rates.rollback.sql

-- 1. Services --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  description        text NULL CHECK (description IS NULL OR length(description) <= 500),
  unit               text NOT NULL CHECK (unit IN ('hour', 'shift', 'day', 'fixed')),
  active             boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_services_org_name
  ON finance_services (organization_id, lower(btrim(name)));

-- 2. Billing clients (private persons) and their residents -----------------------
CREATE TABLE IF NOT EXISTS billing_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  full_name          text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  email              text NULL CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text NULL CHECK (phone IS NULL OR length(phone) <= 40),
  address            text NULL CHECK (address IS NULL OR length(address) <= 300),
  notes              text NULL CHECK (notes IS NULL OR length(notes) <= 1000),
  active             boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS billing_client_recipients (
  billing_client_id  uuid NOT NULL,
  care_recipient_id  uuid NOT NULL,
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  is_primary         boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (billing_client_id, care_recipient_id),
  FOREIGN KEY (billing_client_id, organization_id) REFERENCES billing_clients (id, organization_id),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id)
);
-- One primary payer per resident.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_client_recipients_primary
  ON billing_client_recipients (care_recipient_id) WHERE is_primary;

-- 3. Agency holiday calendar (optional) -------------------------------------------
CREATE TABLE IF NOT EXISTS finance_holidays (
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  holiday_date       date NOT NULL,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, holiday_date)
);

-- 4. Rates -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_rates (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL REFERENCES organizations(id),
  service_id                        uuid NOT NULL,
  rate_kind                         text NOT NULL CHECK (rate_kind IN ('client', 'caregiver')),
  scope                             text NOT NULL CHECK (scope IN ('general', 'client', 'caregiver')),
  billing_client_id                 uuid NULL,
  organization_worker_membership_id uuid NULL,
  day_type                          text NOT NULL DEFAULT 'standard' CHECK (day_type IN ('standard', 'holiday')),
  amount_cents                      integer NOT NULL CHECK (amount_cents BETWEEN 0 AND 1000000),
  currency                          text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  effective_from                    date NOT NULL,
  effective_to                      date NULL,
  min_minutes                       integer NULL CHECK (min_minutes IS NULL OR min_minutes BETWEEN 1 AND 1440),
  rounding_minutes                  integer NULL CHECK (rounding_minutes IS NULL OR rounding_minutes IN (5, 10, 15, 30, 60)),
  half_day_policy                   text NULL CHECK (half_day_policy IS NULL OR half_day_policy IN ('review', 'proportional', 'fixed')),
  half_day_amount_cents             integer NULL CHECK (half_day_amount_cents IS NULL OR half_day_amount_cents BETWEEN 0 AND 1000000),
  reason                            text NULL CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 300),
  created_by_user_id                uuid NOT NULL REFERENCES users(id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  ended_by_user_id                  uuid NULL REFERENCES users(id),
  ended_at                          timestamptz NULL,
  end_reason                        text NULL CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (service_id, organization_id) REFERENCES finance_services (id, organization_id),
  FOREIGN KEY (billing_client_id, organization_id) REFERENCES billing_clients (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id)
    REFERENCES organization_worker_memberships (id, organization_id),
  CONSTRAINT finance_rates_valid_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Billing rates are general or for one client; pay rates general or for one caregiver.
  CONSTRAINT finance_rates_scope_shape CHECK (
    (scope = 'general' AND billing_client_id IS NULL AND organization_worker_membership_id IS NULL)
    OR (scope = 'client' AND rate_kind = 'client' AND billing_client_id IS NOT NULL AND organization_worker_membership_id IS NULL)
    OR (scope = 'caregiver' AND rate_kind = 'caregiver' AND organization_worker_membership_id IS NOT NULL AND billing_client_id IS NULL)
  ),
  CONSTRAINT finance_rates_half_day_shape CHECK (
    (half_day_policy = 'fixed') = (half_day_amount_cents IS NOT NULL)
  ),
  CONSTRAINT finance_rates_end_shape CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_finance_rates_lookup
  ON finance_rates (organization_id, service_id, rate_kind, scope, day_type, effective_from DESC);

-- Unit-specific rules: rounding/minimum only for hourly services; half-day rules only for daily ones.
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
DROP TRIGGER IF EXISTS finance_rates_guard ON finance_rates;
CREATE TRIGGER finance_rates_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_rates
  FOR EACH ROW EXECUTE FUNCTION public.app_finance_rate_guard();

-- The unit of a service never changes (rates and shifts depend on it).
CREATE OR REPLACE FUNCTION public.app_finance_service_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FINANCE_SERVICE_NO_DELETE' USING ERRCODE = '55000';
  END IF;
  IF NEW.unit <> OLD.unit OR NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'FINANCE_SERVICE_UNIT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS finance_services_guard ON finance_services;
CREATE TRIGGER finance_services_guard
  BEFORE UPDATE OR DELETE ON finance_services
  FOR EACH ROW EXECUTE FUNCTION public.app_finance_service_guard();

-- 5. Recipient defaults and shift terms -----------------------------------------
CREATE TABLE IF NOT EXISTS recipient_finance_defaults (
  care_recipient_id  uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  service_id         uuid NULL,
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id),
  FOREIGN KEY (service_id, organization_id) REFERENCES finance_services (id, organization_id)
);

CREATE TABLE IF NOT EXISTS shift_finance_terms (
  shift_id                   uuid PRIMARY KEY,
  organization_id            uuid NOT NULL REFERENCES organizations(id),
  service_id                 uuid NULL,
  billing_client_id          uuid NULL,
  authorized_units_hundredths integer NULL CHECK (authorized_units_hundredths IS NULL OR authorized_units_hundredths BETWEEN 1 AND 100000),
  note                       text NULL CHECK (note IS NULL OR length(note) <= 500),
  updated_by_user_id         uuid NOT NULL REFERENCES users(id),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (service_id, organization_id) REFERENCES finance_services (id, organization_id),
  FOREIGN KEY (billing_client_id, organization_id) REFERENCES billing_clients (id, organization_id)
);

-- A shift whose hours were already approved keeps its service and payer.
CREATE OR REPLACE FUNCTION public.app_shift_finance_terms_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_FINANCE_TERMS_NO_DELETE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.shift_id <> OLD.shift_id OR NEW.organization_id <> OLD.organization_id) THEN
    RAISE EXCEPTION 'SHIFT_FINANCE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.service_id IS DISTINCT FROM OLD.service_id
        OR NEW.billing_client_id IS DISTINCT FROM OLD.billing_client_id)
     AND EXISTS (SELECT 1 FROM public.timesheets t
                 WHERE t.shift_id = NEW.shift_id AND t.organization_id = NEW.organization_id
                   AND t.status = 'approved') THEN
    RAISE EXCEPTION 'SHIFT_FINANCE_LOCKED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_finance_terms_guard ON shift_finance_terms;
CREATE TRIGGER shift_finance_terms_guard
  BEFORE INSERT OR UPDATE OR DELETE ON shift_finance_terms
  FOR EACH ROW EXECUTE FUNCTION public.app_shift_finance_terms_guard();

-- The guard reads timesheets, which the session can read (admin, 085); run it
-- with definer rights so the check never depends on the caller's visibility.
ALTER FUNCTION public.app_shift_finance_terms_guard() SECURITY DEFINER;
ALTER FUNCTION public.app_finance_rate_guard() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.app_shift_finance_terms_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_finance_rate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_finance_service_guard() FROM PUBLIC;

-- 6. Row-level security ------------------------------------------------------------
DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'finance_services', 'billing_clients', 'billing_client_recipients', 'finance_holidays',
    'finance_rates', 'recipient_finance_defaults', 'shift_finance_terms'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', target_table);

    EXECUTE format('DROP POLICY IF EXISTS finance_admin_read ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY finance_admin_read ON %I FOR SELECT TO app_runtime
         USING (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid
                AND public.app_is_org_admin())', target_table);

    -- Writes also need FINANZAS on for the agency (defence behind the route gate).
    EXECUTE format('DROP POLICY IF EXISTS finance_admin_insert ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY finance_admin_insert ON %I FOR INSERT TO app_runtime
         WITH CHECK (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid
                     AND public.app_is_org_admin()
                     AND public.app_org_feature_enabled(organization_id, ''FINANZAS''))', target_table);

    EXECUTE format('DROP POLICY IF EXISTS finance_admin_update ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY finance_admin_update ON %I FOR UPDATE TO app_runtime
         USING (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid
                AND public.app_is_org_admin())
         WITH CHECK (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid
                     AND public.app_is_org_admin()
                     AND public.app_org_feature_enabled(organization_id, ''FINANZAS''))', target_table);

    EXECUTE format('DROP POLICY IF EXISTS platform_finance_deny ON %I', target_table);
    EXECUTE format(
      'CREATE POLICY platform_finance_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime
         USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', target_table);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON finance_services TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON billing_clients TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON billing_client_recipients TO app_runtime;
-- Holidays: a date can be added; removal goes through no route in F1.
GRANT SELECT, INSERT ON finance_holidays TO app_runtime;
-- Rates: insert new versions; only the end of a window can be updated (trigger).
GRANT SELECT, INSERT ON finance_rates TO app_runtime;
GRANT UPDATE (effective_to, ended_by_user_id, ended_at, end_reason) ON finance_rates TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON recipient_finance_defaults TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON shift_finance_terms TO app_runtime;

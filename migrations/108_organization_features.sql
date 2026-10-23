-- Migration 108: per-agency feature enablement (SmartMatch pilot).
--
-- SmartMatch (Gates 1-5) and «En camino» + «Llegué» (Gates 6-7 arrival and
-- journey) stay OFF for every agency until ETNARA central enables them for a
-- pilot agency. Off means: the routes answer 404 FEATURE_NOT_ENABLED, the
-- frontend hides the screens (it reads the codes from /me), background jobs
-- skip the agency, and the database refuses new rows for it (defence in depth).
-- Service addresses (Gate 6 «Dirección del servicio») are core shift data and
-- are NOT gated.
--
-- Only ETNARA central (platform admin) changes the switches; every change is
-- written to an append-only history.

CREATE TABLE IF NOT EXISTS organization_features (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_code text NOT NULL CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO')),
  enabled boolean NOT NULL DEFAULT false,
  updated_by_user_id uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, feature_code)
);

CREATE TABLE IF NOT EXISTS organization_feature_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_code text NOT NULL CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO')),
  enabled boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_feature_events_org ON organization_feature_events (organization_id, occurred_at DESC);

ALTER TABLE organization_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_features FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_feature_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_feature_events FORCE ROW LEVEL SECURITY;

-- Members read their agency's switches; ETNARA central reads and writes all.
DROP POLICY IF EXISTS organization_features_read ON organization_features;
CREATE POLICY organization_features_read ON organization_features
  FOR SELECT
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
         OR app_is_superadmin());
DROP POLICY IF EXISTS organization_features_platform_write ON organization_features;
CREATE POLICY organization_features_platform_write ON organization_features
  FOR ALL
  USING (app_is_superadmin())
  WITH CHECK (app_is_superadmin());

DROP POLICY IF EXISTS organization_feature_events_platform ON organization_feature_events;
CREATE POLICY organization_feature_events_platform ON organization_feature_events
  FOR ALL
  USING (app_is_superadmin())
  WITH CHECK (app_is_superadmin() AND actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON organization_features TO app_runtime;
GRANT SELECT, INSERT ON organization_feature_events TO app_runtime;

CREATE OR REPLACE FUNCTION app_feature_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'ORGANIZATION_FEATURE_EVENTS_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS organization_feature_events_append_only ON organization_feature_events;
CREATE TRIGGER organization_feature_events_append_only
  BEFORE UPDATE OR DELETE ON organization_feature_events
  FOR EACH ROW EXECUTE FUNCTION app_feature_events_append_only();

-- Is the feature on for this agency? Usable from any context (jobs, triggers).
CREATE OR REPLACE FUNCTION app_org_feature_enabled(p_organization_id uuid, p_feature_code text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((SELECT f.enabled FROM public.organization_features f
                   WHERE f.organization_id = p_organization_id AND f.feature_code = p_feature_code), false);
$$;

-- Codes enabled for an agency, only for its active members (used by /me).
CREATE OR REPLACE FUNCTION app_my_org_features(p_organization_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(f.feature_code ORDER BY f.feature_code), '{}')
  FROM public.organization_features f
  WHERE f.organization_id = p_organization_id AND f.enabled
    AND EXISTS (SELECT 1 FROM public.organization_memberships om
                WHERE om.organization_id = p_organization_id AND om.status = 'active'
                  AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
$$;
REVOKE ALL ON FUNCTION app_org_feature_enabled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_my_org_features(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_org_feature_enabled(uuid, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_my_org_features(uuid) TO app_runtime;

-- ------------------------------------------------------------ database barrier
-- New SmartMatch opportunities, journey events and arrivals are refused for an
-- agency that does not have the feature (defence in depth behind the routes).
CREATE OR REPLACE FUNCTION app_require_org_feature()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_org_feature_enabled(NEW.organization_id, TG_ARGV[0]) THEN
    RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501', DETAIL = TG_ARGV[0];
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS smartmatch_opportunities_feature ON smartmatch_opportunities;
CREATE TRIGGER smartmatch_opportunities_feature BEFORE INSERT ON smartmatch_opportunities
  FOR EACH ROW EXECUTE FUNCTION app_require_org_feature('SMARTMATCH');
DROP TRIGGER IF EXISTS smartmatch_applications_feature ON smartmatch_applications;
CREATE TRIGGER smartmatch_applications_feature BEFORE INSERT ON smartmatch_applications
  FOR EACH ROW EXECUTE FUNCTION app_require_org_feature('SMARTMATCH');
DROP TRIGGER IF EXISTS shift_journey_events_feature ON shift_journey_events;
CREATE TRIGGER shift_journey_events_feature BEFORE INSERT ON shift_journey_events
  FOR EACH ROW EXECUTE FUNCTION app_require_org_feature('EN_CAMINO');
DROP TRIGGER IF EXISTS shift_arrivals_feature ON shift_arrivals;
CREATE TRIGGER shift_arrivals_feature BEFORE INSERT ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_require_org_feature('EN_CAMINO');

-- ------------------------------------------------------------ background jobs
-- Late-arrival and «no ha salido» notices only for agencies with «En camino».
CREATE OR REPLACE FUNCTION app_notify_late_shift_arrivals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total integer := 0;
  late record;
BEGIN
  PERFORM public.app_assert_background_job();
  FOR late IN
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status IN ('unassigned', 'confirmed')
      AND s.scheduled_start <= now() - interval '15 minutes'
      AND s.scheduled_start > now() - interval '12 hours'
      AND s.scheduled_end > now()
      AND public.app_org_feature_enabled(s.organization_id, 'EN_CAMINO')
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.related_entity_id = s.id AND n.notification_type = 'SHIFT_LATE_ARRIVAL')
  LOOP
    total := total + public.app_notify_shift_managers(late.organization_id, late.id, 'SHIFT_LATE_ARRIVAL');
  END LOOP;
  RETURN total;
END;
$$;

CREATE OR REPLACE FUNCTION app_notify_shifts_not_en_route()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total integer := 0;
  r record;
BEGIN
  PERFORM public.app_assert_background_job();
  FOR r IN
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status = 'confirmed'
      AND s.scheduled_start <= now() + interval '30 minutes'
      AND s.scheduled_start > now()
      AND public.app_org_feature_enabled(s.organization_id, 'EN_CAMINO')
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = s.id AND e.organization_id = s.organization_id
                      AND e.event_type = 'EN_ROUTE')
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.related_entity_id = s.id AND n.notification_type = 'SHIFT_NOT_EN_ROUTE')
  LOOP
    total := total + public.app_notify_shift_managers(r.organization_id, r.id, 'SHIFT_NOT_EN_ROUTE');
  END LOOP;
  RETURN total;
END;
$$;

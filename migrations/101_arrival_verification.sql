-- Migration 101: Gate 6 -- arrival at the service location, optional proximity
-- check with separate consent, late-arrival notification.
--
-- Decisions (user, Gate 6):
--   * "Llegué" (arrival, optional) + "Iniciar" (existing check_in) + "Finalizar"
--     (existing check_out). Lateness is measured with the first of arrival/check-in.
--   * Proximity: the phone sends ONE reading only with active consent; the server
--     compares it with the shift's address and keeps only the result
--     (NEAR / FAR / NO_CONSENT / UNAVAILABLE / NO_REFERENCE) and a rounded
--     distance. Coordinates are never stored. No tracking, no routes.
--   * No GPS / no consent / far: the arrival is still recorded and flagged for
--     administrative review. The service is never blocked.
-- The verification_event_type enum and verification_events are not changed.

-- 1. Separate consent for location checks ---------------------------------
CREATE TABLE IF NOT EXISTS worker_location_consents (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                    uuid NOT NULL REFERENCES organizations(id),
  organization_worker_membership_id  uuid NOT NULL,
  user_id                            uuid NOT NULL REFERENCES users(id),
  consent_version                    text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 40),
  granted_at                         timestamptz NOT NULL DEFAULT now(),
  revoked_at                         timestamptz NULL,
  FOREIGN KEY (organization_worker_membership_id, organization_id)
    REFERENCES organization_worker_memberships (id, organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_location_consents_one_active
  ON worker_location_consents (organization_worker_membership_id) WHERE revoked_at IS NULL;

-- The membership must be the caller's own worker membership in this agency.
CREATE OR REPLACE FUNCTION app_is_own_worker_membership(p_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_worker_memberships owm
    WHERE owm.id = p_membership_id
      AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND owm.status = 'active'
      AND owm.worker_id IN (SELECT worker_id FROM public.app_current_worker_ids())
  );
$$;
REVOKE ALL ON FUNCTION app_is_own_worker_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_own_worker_membership(uuid) TO app_runtime;

-- Consent is append-only apart from revocation.
CREATE OR REPLACE FUNCTION app_worker_location_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR (NEW.organization_id, NEW.organization_worker_membership_id, NEW.user_id, NEW.consent_version, NEW.granted_at)
        IS DISTINCT FROM (OLD.organization_id, OLD.organization_worker_membership_id, OLD.user_id, OLD.consent_version, OLD.granted_at) THEN
    RAISE EXCEPTION 'LOCATION_CONSENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS worker_location_consents_guard ON worker_location_consents;
CREATE TRIGGER worker_location_consents_guard
  BEFORE UPDATE ON worker_location_consents
  FOR EACH ROW EXECUTE FUNCTION app_worker_location_consent_guard();

ALTER TABLE worker_location_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_location_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_location_consents_own ON worker_location_consents
  FOR ALL TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND app_is_own_worker_membership(organization_worker_membership_id));
CREATE POLICY worker_location_consents_manager_read ON worker_location_consents
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON worker_location_consents
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON worker_location_consents TO app_runtime;
GRANT INSERT (organization_id, organization_worker_membership_id, user_id, consent_version) ON worker_location_consents TO app_runtime;
GRANT UPDATE (revoked_at) ON worker_location_consents TO app_runtime;

-- 2. Arrival ("Llegué") ----------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_arrivals (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                    uuid NOT NULL REFERENCES organizations(id),
  shift_id                           uuid NOT NULL,
  organization_worker_membership_id  uuid NOT NULL,
  recorded_by_user_id                uuid NOT NULL REFERENCES users(id),
  occurred_at                        timestamptz NOT NULL DEFAULT now(),
  recorded_offline                   boolean NOT NULL DEFAULT false,
  client_event_id                    uuid NULL,
  proximity                          text NOT NULL CHECK (proximity IN ('NEAR','FAR','NO_CONSENT','UNAVAILABLE','NO_REFERENCE')),
  -- Rounded to 10 m; never the coordinates themselves.
  distance_m                         integer NULL CHECK (distance_m IS NULL OR (distance_m >= 0 AND distance_m % 10 = 0)),
  accuracy_m                         integer NULL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  needs_review                       boolean NOT NULL,
  reviewed_by_user_id                uuid NULL REFERENCES users(id),
  reviewed_at                        timestamptz NULL,
  review_note                        text NULL CHECK (review_note IS NULL OR char_length(review_note) <= 300),
  created_at                         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id)
    REFERENCES organization_worker_memberships (id, organization_id),
  UNIQUE (shift_id, organization_worker_membership_id),
  CHECK ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)),
  CHECK (needs_review = (proximity IN ('FAR','NO_CONSENT','UNAVAILABLE')))
);
CREATE UNIQUE INDEX IF NOT EXISTS shift_arrivals_client_event
  ON shift_arrivals (organization_id, organization_worker_membership_id, client_event_id) WHERE client_event_id IS NOT NULL;

-- After insert, only the review fields may change, once.
CREATE OR REPLACE FUNCTION app_shift_arrival_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'SHIFT_ARRIVAL_ALREADY_REVIEWED' USING ERRCODE = '23514';
  END IF;
  IF (NEW.organization_id, NEW.shift_id, NEW.organization_worker_membership_id, NEW.recorded_by_user_id, NEW.occurred_at,
      NEW.recorded_offline, NEW.client_event_id, NEW.proximity, NEW.distance_m, NEW.accuracy_m, NEW.needs_review, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.shift_id, OLD.organization_worker_membership_id, OLD.recorded_by_user_id, OLD.occurred_at,
      OLD.recorded_offline, OLD.client_event_id, OLD.proximity, OLD.distance_m, OLD.accuracy_m, OLD.needs_review, OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_ARRIVAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_arrivals_guard ON shift_arrivals;
CREATE TRIGGER shift_arrivals_guard BEFORE UPDATE ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_shift_arrival_guard();

ALTER TABLE shift_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_arrivals FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_arrivals_worker_insert ON shift_arrivals
  FOR INSERT TO app_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND recorded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND app_is_own_worker_membership(organization_worker_membership_id)
    AND app_worker_has_shift_assignment(shift_id)
  );
CREATE POLICY shift_arrivals_worker_read ON shift_arrivals
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_own_worker_membership(organization_worker_membership_id));
CREATE POLICY shift_arrivals_manager_read ON shift_arrivals
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY shift_arrivals_manager_review ON shift_arrivals
  FOR UPDATE TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()
              AND reviewed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY platform_phi_deny ON shift_arrivals
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON shift_arrivals TO app_runtime;
GRANT INSERT (organization_id, shift_id, organization_worker_membership_id, recorded_by_user_id, occurred_at,
              recorded_offline, client_event_id, proximity, distance_m, accuracy_m, needs_review)
  ON shift_arrivals TO app_runtime;
GRANT UPDATE (reviewed_by_user_id, reviewed_at, review_note) ON shift_arrivals TO app_runtime;

-- 3. Notifications to the agency (managers), never with the address --------
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_shift_arrival_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE notification_type IN ('SHIFT_LATE_ARRIVAL', 'SHIFT_ARRIVAL_NEEDS_REVIEW');

CREATE OR REPLACE FUNCTION app_notify_shift_managers(p_organization_id uuid, p_shift_id uuid, p_type text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT om.user_id, p_organization_id, p_type, 'shift', p_shift_id, NULL::uuid, 'in_app', 'sent', now()
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.organization_id = p_organization_id AND om.status = 'active'
      AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM inserted;
$$;
REVOKE ALL ON FUNCTION app_notify_shift_managers(uuid, uuid, text) FROM PUBLIC;

-- Arrival needing review -> managers (called by the trigger, not by clients).
CREATE OR REPLACE FUNCTION app_shift_arrival_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.needs_review THEN
    PERFORM public.app_notify_shift_managers(NEW.organization_id, NEW.shift_id, 'SHIFT_ARRIVAL_NEEDS_REVIEW');
  END IF;
  -- An arrival resolves an open late-arrival notice.
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
    AND notification_type = 'SHIFT_LATE_ARRIVAL' AND organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_arrival_notify() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_arrivals_notify ON shift_arrivals;
CREATE TRIGGER shift_arrivals_notify AFTER INSERT ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_shift_arrival_notify();

-- Late arrival: 15 minutes after the start with an assigned caregiver and
-- neither "Llegué" nor check-in. Cross-tenant job for the API's background
-- worker (same pattern as app_advance_due_coverage_campaigns); returns only a count.
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
  FOR late IN
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status IN ('unassigned', 'confirmed')
      AND s.scheduled_start <= now() - interval '15 minutes'
      AND s.scheduled_start > now() - interval '12 hours'
      AND s.scheduled_end > now()
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
  LOOP
    total := total + public.app_notify_shift_managers(late.organization_id, late.id, 'SHIFT_LATE_ARRIVAL');
  END LOOP;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION app_notify_late_shift_arrivals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_late_shift_arrivals() TO app_runtime;

-- A check-in also resolves an open late-arrival notice.
CREATE OR REPLACE FUNCTION app_check_in_resolves_late_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.event_type = 'check_in' THEN
    UPDATE public.notifications SET read_at = COALESCE(read_at, now())
    WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
      AND notification_type = 'SHIFT_LATE_ARRIVAL' AND organization_id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_check_in_resolves_late_notice() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_events_resolve_late_notice ON verification_events;
CREATE TRIGGER verification_events_resolve_late_notice AFTER INSERT ON verification_events
  FOR EACH ROW EXECUTE FUNCTION app_check_in_resolves_late_notice();

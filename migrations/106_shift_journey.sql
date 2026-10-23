-- Migration 106: Gate 7 -- «ETNARA En Camino».
--
-- Families and the agency learn when the caregiver is on the way, arrives and
-- starts / finishes the service. Version 1: NO GPS, NO tracking, NO routes,
-- NO estimated times. The caregiver declares «Voy en camino» and, if needed,
-- a delay from fixed options with a reason category (no free text).
--
-- Decisions (user, Gate 7):
--   1. Every active relative authorised for the shift sees the journey state.
--   2. Families see declared delays, labelled as declared (never an ETA).
--   3. «Voy en camino»: from 2 h before to 1 h after the scheduled start.
--   4. Agency alerts: no departure 30 min before (preventive), no arrival 15 min
--      after the start (existing 101 notice), declared delay >= 30 min.
--   5. Family notices: en camino, llegó, retraso (new); servicio iniciado /
--      finalizado reuse the existing SHIFT_STARTED / SHIFT_COMPLETED notices.
--   6. An arrival needing review is shown to the family only as «Llegada registrada».
--   7. Delay reasons: predefined categories only.
--
-- Reused, unchanged: shifts, assignments, shift_arrivals (101),
-- verification_events (check_in / check_out), notifications, the API's
-- background worker. The journey state is DERIVED from those tables plus the
-- new append-only shift_journey_events, so «En camino» stops by itself when an
-- arrival, check-in, check-out or cancellation exists.

-- 1. Append-only journey events (no coordinate columns) ---------------------
CREATE TABLE IF NOT EXISTS shift_journey_events (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                    uuid NOT NULL REFERENCES organizations(id),
  shift_id                           uuid NOT NULL,
  organization_worker_membership_id  uuid NOT NULL,
  recorded_by_user_id                uuid NOT NULL REFERENCES users(id),
  event_type                         text NOT NULL CHECK (event_type IN ('EN_ROUTE', 'DELAY_REPORTED')),
  occurred_at                        timestamptz NOT NULL DEFAULT now(),
  declared_delay_minutes             smallint NULL CHECK (declared_delay_minutes IN (10, 15, 30, 45, 60)),
  delay_reason                       text NULL CHECK (delay_reason IN ('TRAFFIC', 'PREVIOUS_SERVICE', 'TRANSPORT', 'WEATHER', 'OTHER')),
  recorded_offline                   boolean NOT NULL DEFAULT false,
  client_event_id                    uuid NULL,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id)
    REFERENCES organization_worker_memberships (id, organization_id),
  CHECK ((event_type = 'EN_ROUTE' AND declared_delay_minutes IS NULL AND delay_reason IS NULL)
      OR (event_type = 'DELAY_REPORTED' AND declared_delay_minutes IS NOT NULL AND delay_reason IS NOT NULL))
);
-- One departure per caregiver and shift (idempotent «Voy en camino»).
CREATE UNIQUE INDEX IF NOT EXISTS shift_journey_one_departure
  ON shift_journey_events (shift_id, organization_worker_membership_id) WHERE event_type = 'EN_ROUTE';
CREATE UNIQUE INDEX IF NOT EXISTS shift_journey_client_event
  ON shift_journey_events (organization_id, organization_worker_membership_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_journey_by_shift ON shift_journey_events (shift_id, occurred_at);

-- Validation in the database (not only in the app): the caller's own accepted
-- assignment, a confirmed shift, inside the window, before arrival/check-in.
CREATE OR REPLACE FUNCTION app_shift_journey_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  s record;
  last_delay record;
  delays integer;
BEGIN
  -- Serialise journey writes per shift (delay count / repeat checks).
  PERFORM pg_advisory_xact_lock(hashtextextended('journey:' || NEW.shift_id::text, 0));
  SELECT id, status::text AS status, scheduled_start, scheduled_end INTO s
  FROM public.shifts WHERE id = NEW.shift_id AND organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_FOUND' USING ERRCODE = '23514'; END IF;
  IF s.status <> 'confirmed' THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                 AND a.organization_worker_membership_id = NEW.organization_worker_membership_id AND a.response_status = 'accepted') THEN
    RAISE EXCEPTION 'JOURNEY_ASSIGNMENT_NOT_ACCEPTED' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at > now() + interval '1 minute' OR NEW.occurred_at < now() - interval '60 minutes' THEN
    RAISE EXCEPTION 'JOURNEY_TIME_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at < s.scheduled_start - interval '2 hours' OR NEW.occurred_at > s.scheduled_start + interval '1 hour' THEN
    RAISE EXCEPTION 'JOURNEY_OUTSIDE_WINDOW' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = NEW.shift_id AND sa.organization_id = NEW.organization_id)
     OR EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = NEW.shift_id
                AND ve.organization_id = NEW.organization_id AND ve.event_type = 'check_in') THEN
    RAISE EXCEPTION 'JOURNEY_ALREADY_ARRIVED' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'DELAY_REPORTED' THEN
    SELECT count(*) INTO delays FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED';
    IF delays >= 3 THEN RAISE EXCEPTION 'JOURNEY_DELAY_LIMIT' USING ERRCODE = '23514'; END IF;
    SELECT declared_delay_minutes, delay_reason INTO last_delay FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED' ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
    IF FOUND AND last_delay.declared_delay_minutes = NEW.declared_delay_minutes AND last_delay.delay_reason = NEW.delay_reason THEN
      RAISE EXCEPTION 'JOURNEY_DELAY_UNCHANGED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_journey_validate() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_journey_validate ON shift_journey_events;
CREATE TRIGGER shift_journey_validate BEFORE INSERT ON shift_journey_events
  FOR EACH ROW EXECUTE FUNCTION app_shift_journey_validate();

-- Auditable: never updated, never deleted.
CREATE OR REPLACE FUNCTION app_shift_journey_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'SHIFT_JOURNEY_EVENT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS shift_journey_immutable ON shift_journey_events;
CREATE TRIGGER shift_journey_immutable BEFORE UPDATE OR DELETE ON shift_journey_events
  FOR EACH ROW EXECUTE FUNCTION app_shift_journey_immutable();

ALTER TABLE shift_journey_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_journey_events FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_journey_worker_insert ON shift_journey_events
  FOR INSERT TO app_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND recorded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND app_is_own_worker_membership(organization_worker_membership_id)
    AND app_worker_has_shift_assignment(shift_id)
  );
CREATE POLICY shift_journey_worker_read ON shift_journey_events
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_own_worker_membership(organization_worker_membership_id));
CREATE POLICY shift_journey_manager_read ON shift_journey_events
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON shift_journey_events
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON shift_journey_events TO app_runtime;
GRANT INSERT (organization_id, shift_id, organization_worker_membership_id, recorded_by_user_id, event_type, occurred_at,
              declared_delay_minutes, delay_reason, recorded_offline, client_event_id)
  ON shift_journey_events TO app_runtime;
-- Families never read this table: they get the derived state below.

-- 2. Derived journey state (one source for the three portals) ---------------
-- Returns nothing when the caller may not see the shift. Families get no
-- review flag and no caregiver identifiers; nobody gets coordinates (none exist).
CREATE OR REPLACE FUNCTION app_shift_journey_state(p_shift_id uuid)
RETURNS TABLE (
  shift_id uuid, state text, en_route_at timestamptz, delay_minutes smallint, delay_reason text,
  delay_reported_at timestamptz, arrived_at timestamptz, arrival_needs_review boolean,
  started_at timestamptz, finished_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  me uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  s record;
  is_manager boolean;
  allowed boolean;
  acc record;
  dly record;
BEGIN
  IF org IS NULL OR me IS NULL OR COALESCE(current_setting('app.is_superadmin', true), 'false') = 'true' THEN RETURN; END IF;
  SELECT x.id, x.status::text AS status, x.care_recipient_id INTO s
  FROM public.shifts x WHERE x.id = p_shift_id AND x.organization_id = org;
  IF NOT FOUND THEN RETURN; END IF;
  is_manager := public.app_is_org_manager();
  allowed := is_manager
    OR EXISTS (SELECT 1 FROM public.assignments a JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
               JOIN public.workers w ON w.id = owm.worker_id
               WHERE a.shift_id = s.id AND a.organization_id = org AND w.user_id = me AND owm.status = 'active'
                 AND a.response_status IN ('pending', 'accepted'))
    OR (s.care_recipient_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.family_relationships fr
          WHERE fr.user_id = me AND fr.organization_id = org AND fr.care_recipient_id = s.care_recipient_id AND fr.status = 'active')
        AND public.app_user_authorized_for_recipient(me, org, s.care_recipient_id));
  IF NOT allowed THEN RETURN; END IF;

  SELECT a.organization_worker_membership_id, a.response_status::text AS response_status INTO acc
  FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = org AND a.response_status IN ('pending', 'accepted')
  ORDER BY (a.response_status = 'accepted') DESC, a.created_at DESC LIMIT 1;

  shift_id := s.id;
  SELECT min(e.occurred_at) INTO en_route_at FROM public.shift_journey_events e
  WHERE e.shift_id = s.id AND e.organization_id = org AND e.event_type = 'EN_ROUTE'
    AND acc.response_status = 'accepted' AND e.organization_worker_membership_id = acc.organization_worker_membership_id;
  SELECT e.declared_delay_minutes, e.delay_reason, e.occurred_at INTO dly FROM public.shift_journey_events e
  WHERE e.shift_id = s.id AND e.organization_id = org AND e.event_type = 'DELAY_REPORTED'
    AND acc.response_status = 'accepted' AND e.organization_worker_membership_id = acc.organization_worker_membership_id
  ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1;
  delay_minutes := dly.declared_delay_minutes; delay_reason := dly.delay_reason; delay_reported_at := dly.occurred_at;
  SELECT min(sa.occurred_at), bool_or(sa.needs_review AND sa.reviewed_at IS NULL) INTO arrived_at, arrival_needs_review
  FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = org;
  SELECT min(ve.occurred_at) FILTER (WHERE ve.event_type = 'check_in'), max(ve.occurred_at) FILTER (WHERE ve.event_type = 'check_out')
    INTO started_at, finished_at
  FROM public.verification_events ve WHERE ve.shift_id = s.id AND ve.organization_id = org;
  IF NOT is_manager AND NOT EXISTS (SELECT 1 FROM public.assignments a JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
               JOIN public.workers w ON w.id = owm.worker_id WHERE a.shift_id = s.id AND a.organization_id = org AND w.user_id = me) THEN
    arrival_needs_review := NULL;   -- family: «Llegada registrada» only
  END IF;

  state := CASE
    WHEN s.status = 'cancelled' THEN 'CANCELLED'
    WHEN finished_at IS NOT NULL OR s.status = 'completed' THEN 'COMPLETED'
    WHEN started_at IS NOT NULL OR s.status = 'in_progress' THEN 'IN_SERVICE'
    WHEN arrived_at IS NOT NULL THEN 'ARRIVED'
    WHEN en_route_at IS NOT NULL THEN 'EN_ROUTE'
    WHEN acc.response_status = 'accepted' THEN 'ASSIGNED'
    WHEN acc.response_status = 'pending' THEN 'PENDING_ACCEPTANCE'
    ELSE 'UNASSIGNED' END;
  -- «En camino» and delays stop mattering once the visit moved on or was cancelled.
  IF state NOT IN ('ASSIGNED', 'EN_ROUTE') THEN
    delay_minutes := CASE WHEN state IN ('CANCELLED', 'UNASSIGNED', 'PENDING_ACCEPTANCE') THEN NULL ELSE delay_minutes END;
    delay_reason := CASE WHEN state IN ('CANCELLED', 'UNASSIGNED', 'PENDING_ACCEPTANCE') THEN NULL ELSE delay_reason END;
    delay_reported_at := CASE WHEN state IN ('CANCELLED', 'UNASSIGNED', 'PENDING_ACCEPTANCE') THEN NULL ELSE delay_reported_at END;
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_journey_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shift_journey_state(uuid) TO app_runtime;

-- 3. Notifications: never an address, never a location; deduplicated --------
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_journey_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE notification_type IN ('FAMILY_CAREGIVER_EN_ROUTE', 'FAMILY_CAREGIVER_DELAYED', 'FAMILY_CAREGIVER_ARRIVED',
                              'SHIFT_NOT_EN_ROUTE', 'SHIFT_DELAY_REPORTED');

-- Family: active relatives authorised for the person, who accept notifications.
-- Never for a cancelled shift or without an accepted assignment.
CREATE OR REPLACE FUNCTION app_notify_shift_family(p_organization_id uuid, p_shift_id uuid, p_type text, p_entity_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT fr.user_id, s.organization_id, p_type,
           CASE WHEN p_entity_id = s.id THEN 'shift' ELSE 'shift_journey_event' END,
           p_entity_id, s.care_recipient_id, 'in_app', 'sent', now()
    FROM public.shifts s
    JOIN public.family_relationships fr ON fr.organization_id = s.organization_id AND fr.care_recipient_id = s.care_recipient_id
    WHERE s.id = p_shift_id AND s.organization_id = p_organization_id
      AND s.status <> 'cancelled' AND s.care_recipient_id IS NOT NULL
      AND fr.status = 'active' AND fr.can_receive_notifications
      AND public.app_user_authorized_for_recipient(fr.user_id, s.organization_id, s.care_recipient_id)
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status = 'accepted')
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM inserted;
$$;
REVOKE ALL ON FUNCTION app_notify_shift_family(uuid, uuid, text, uuid) FROM PUBLIC;

-- Journey events -> family (en camino / retraso) and managers (retraso >= 30).
-- Any departure or arrival resolves the preventive «sin salida» notice.
CREATE OR REPLACE FUNCTION app_shift_journey_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.event_type = 'EN_ROUTE' THEN
    PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_EN_ROUTE', NEW.shift_id);
  ELSE
    PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_DELAYED', NEW.id);
    IF NEW.declared_delay_minutes >= 30 THEN
      PERFORM public.app_notify_shift_managers(NEW.organization_id, NEW.shift_id, 'SHIFT_DELAY_REPORTED');
    END IF;
  END IF;
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
    AND notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW.organization_id AND read_at IS NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_journey_notify() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_journey_notify ON shift_journey_events;
CREATE TRIGGER shift_journey_notify AFTER INSERT ON shift_journey_events
  FOR EACH ROW EXECUTE FUNCTION app_shift_journey_notify();

-- Arrival (101 table) -> family «Llegó» (no review detail); resolves «sin salida».
CREATE OR REPLACE FUNCTION app_shift_arrival_notify_family()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_ARRIVED', NEW.shift_id);
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
    AND notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW.organization_id AND read_at IS NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_arrival_notify_family() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_arrivals_notify_family ON shift_arrivals;
CREATE TRIGGER shift_arrivals_notify_family AFTER INSERT ON shift_arrivals
  FOR EACH ROW EXECUTE FUNCTION app_shift_arrival_notify_family();

-- Check-in / check-out already notify the family (SHIFT_STARTED / SHIFT_COMPLETED,
-- verification.service): reused, not duplicated. A check-in only resolves the
-- preventive «sin salida» notice.
CREATE OR REPLACE FUNCTION app_check_in_resolves_not_en_route()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.event_type = 'check_in' AND NEW.shift_id IS NOT NULL THEN
    UPDATE public.notifications SET read_at = COALESCE(read_at, now())
    WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
      AND notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW.organization_id AND read_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_check_in_resolves_not_en_route() FROM PUBLIC;
DROP TRIGGER IF EXISTS verification_events_resolve_not_en_route ON verification_events;
CREATE TRIGGER verification_events_resolve_not_en_route AFTER INSERT ON verification_events
  FOR EACH ROW EXECUTE FUNCTION app_check_in_resolves_not_en_route();

-- Preventive alert: 30 min before the start, an assigned caregiver (pending or
-- accepted) has not declared a departure, arrival or check-in. Cross-tenant
-- job for the API's background worker; returns only a count. It warns, it does
-- not assert a breach.
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
  FOR r IN
    SELECT s.id, s.organization_id
    FROM public.shifts s
    WHERE s.status = 'confirmed'
      AND s.scheduled_start <= now() + interval '30 minutes'
      AND s.scheduled_start > now()
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = s.id AND e.organization_id = s.organization_id
                      AND e.event_type = 'EN_ROUTE')
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
  LOOP
    total := total + public.app_notify_shift_managers(r.organization_id, r.id, 'SHIFT_NOT_EN_ROUTE');
  END LOOP;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION app_notify_shifts_not_en_route() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_shifts_not_en_route() TO app_runtime;

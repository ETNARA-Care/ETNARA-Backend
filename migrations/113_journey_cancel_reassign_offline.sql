-- Migration 113: «En camino» / «Llegué» operational safety (audit 24-oct-2026).
--
-- 1. Cancellation tells people: when a shift becomes cancelled, every caregiver
--    still assigned (pending/accepted) gets SHIFT_CANCELLED and the relatives of
--    the person (active, authorised, notifications on) get FAMILY_VISIT_CANCELLED.
--    One notice per person per shift (unique index); never an address.
-- 2. Removal/reassignment tells people: each audited removal (assignment_removal_audit,
--    one row per removal) gives the removed caregiver SHIFT_UNASSIGNED and, if she had
--    accepted, the relatives FAMILY_CAREGIVER_CHANGED. When no caregiver is left the
--    open journey alerts are closed.
-- 3. A new caregiver's departure is announced too: FAMILY_CAREGIVER_EN_ROUTE now
--    points at the departure event (one per caregiver) instead of the shift.
-- 4. Offline sync: a departure recorded on the phone may arrive up to 12 h later
--    (was 60 min), still only inside its window (-2 h .. +1 h of the start) and
--    never after the caregiver had already arrived / started. Events that reach the
--    server late (offline, > 30 min old, or after the visit moved on) are kept in the
--    history but do not send stale notices to the family or the agency.
-- 5. «Sin llegada (15 min)» respects a declared delay: the agency is alerted 15 min
--    after start + declared delay, not 15 min after the start.
-- 1-2 apply to agencies with EN_CAMINO on (pilot), like every journey notice since 108;
-- other agencies see no change. No data is changed. Functions are SECURITY DEFINER with a fixed search_path and
-- not executable by PUBLIC (triggers / background job only), like 101/106/107.

-- ------------------------------------------------------------------ dedupe
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_shift_cancelled_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE notification_type IN ('SHIFT_CANCELLED', 'FAMILY_VISIT_CANCELLED');

-- ------------------------------------------------------------------ 1. cancellation
CREATE OR REPLACE FUNCTION app_shift_cancel_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Pilot agencies only (EN_CAMINO on), like every other journey notice (108).
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled'
     AND public.app_org_feature_enabled(NEW.organization_id, 'EN_CAMINO') THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT w.user_id, NEW.organization_id, 'SHIFT_CANCELLED', 'shift', NEW.id, NULL::uuid, 'in_app', 'sent', now()
    FROM public.assignments a
    JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id AND owm.organization_id = a.organization_id
    JOIN public.workers w ON w.id = owm.worker_id
    WHERE a.shift_id = NEW.id AND a.organization_id = NEW.organization_id
      AND a.response_status IN ('pending', 'accepted') AND w.user_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    IF NEW.care_recipient_id IS NOT NULL AND NEW.scheduled_end > now() THEN
      INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                        related_entity_id, care_recipient_id, channel, status, sent_at)
      SELECT DISTINCT fr.user_id, NEW.organization_id, 'FAMILY_VISIT_CANCELLED', 'shift', NEW.id, NEW.care_recipient_id, 'in_app', 'sent', now()
      FROM public.family_relationships fr
      WHERE fr.organization_id = NEW.organization_id AND fr.care_recipient_id = NEW.care_recipient_id
        AND fr.status = 'active' AND fr.can_receive_notifications
        AND public.app_user_authorized_for_recipient(fr.user_id, NEW.organization_id, NEW.care_recipient_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_cancel_notify() FROM PUBLIC;
DROP TRIGGER IF EXISTS shifts_cancel_notify ON shifts;
CREATE TRIGGER shifts_cancel_notify AFTER UPDATE OF status ON shifts
  FOR EACH ROW EXECUTE FUNCTION app_shift_cancel_notify();

-- ------------------------------------------------------------------ 2. removal / reassignment
CREATE OR REPLACE FUNCTION app_assignment_removal_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE s record;
BEGIN
  SELECT id, status::text AS status, care_recipient_id, scheduled_end INTO s
  FROM public.shifts WHERE id = NEW.shift_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR s.status = 'cancelled' OR s.scheduled_end <= now()
     OR NOT public.app_org_feature_enabled(NEW.organization_id, 'EN_CAMINO') THEN RETURN NEW; END IF;

  IF NEW.previous_response_status IN ('pending', 'accepted') THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT w.user_id, NEW.organization_id, 'SHIFT_UNASSIGNED', 'shift', NEW.shift_id, NULL::uuid, 'in_app', 'sent', now()
    FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
    WHERE owm.id = NEW.organization_worker_membership_id AND owm.organization_id = NEW.organization_id AND w.user_id IS NOT NULL;
  END IF;

  IF NEW.previous_response_status = 'accepted' AND s.care_recipient_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT fr.user_id, NEW.organization_id, 'FAMILY_CAREGIVER_CHANGED', 'shift', NEW.shift_id, s.care_recipient_id, 'in_app', 'sent', now()
    FROM public.family_relationships fr
    WHERE fr.organization_id = NEW.organization_id AND fr.care_recipient_id = s.care_recipient_id
      AND fr.status = 'active' AND fr.can_receive_notifications
      AND public.app_user_authorized_for_recipient(fr.user_id, NEW.organization_id, s.care_recipient_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_assignment_removal_notify() FROM PUBLIC;
DROP TRIGGER IF EXISTS assignment_removal_notify ON assignment_removal_audit;
CREATE TRIGGER assignment_removal_notify AFTER INSERT ON assignment_removal_audit
  FOR EACH ROW EXECUTE FUNCTION app_assignment_removal_notify();

-- Last active caregiver removed: the «sin salida» / «sin llegada» / retraso alerts no longer apply.
CREATE OR REPLACE FUNCTION app_assignment_delete_closes_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = OLD.shift_id AND a.organization_id = OLD.organization_id
                 AND a.response_status IN ('pending', 'accepted')) THEN
    PERFORM public.app_close_journey_alerts(OLD.shift_id);
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app_assignment_delete_closes_alerts() FROM PUBLIC;
DROP TRIGGER IF EXISTS assignments_delete_closes_alerts ON assignments;
CREATE TRIGGER assignments_delete_closes_alerts AFTER DELETE ON assignments
  FOR EACH ROW EXECUTE FUNCTION app_assignment_delete_closes_alerts();

-- ------------------------------------------------------------------ 4. stale events do not notify
-- An event is "stale" when it reaches the server long after it happened, or after the
-- visit already moved on (arrival / check-in recorded at or after it).
CREATE OR REPLACE FUNCTION app_journey_event_is_stale(p_org uuid, p_shift uuid, p_occurred timestamptz, p_offline boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (p_offline AND p_occurred < now() - interval '30 minutes')
      OR EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = p_shift AND ve.organization_id = p_org
                 AND ve.event_type = 'check_in');
$$;
REVOKE ALL ON FUNCTION app_journey_event_is_stale(uuid, uuid, timestamptz, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_shift_journey_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Any departure or delay resolves the preventive «sin salida» notice, even when late.
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
    AND notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW.organization_id AND read_at IS NULL;
  IF public.app_journey_event_is_stale(NEW.organization_id, NEW.shift_id, NEW.occurred_at, NEW.recorded_offline)
     OR EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = NEW.shift_id AND sa.organization_id = NEW.organization_id) THEN
    RETURN NEW;   -- kept in the history; no stale notice
  END IF;
  IF NEW.event_type = 'EN_ROUTE' THEN
    -- per departure event: a replacement caregiver's departure is announced too
    PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_EN_ROUTE', NEW.id);
  ELSE
    PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_DELAYED', NEW.id);
    IF NEW.declared_delay_minutes >= 30 THEN
      PERFORM public.app_notify_shift_managers(NEW.organization_id, NEW.shift_id, 'SHIFT_DELAY_REPORTED');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_journey_notify() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_shift_arrival_notify_family()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.notifications SET read_at = COALESCE(read_at, now())
  WHERE related_entity_type = 'shift' AND related_entity_id = NEW.shift_id
    AND notification_type = 'SHIFT_NOT_EN_ROUTE' AND organization_id = NEW.organization_id AND read_at IS NULL;
  IF NOT public.app_journey_event_is_stale(NEW.organization_id, NEW.shift_id, NEW.occurred_at, NEW.recorded_offline) THEN
    PERFORM public.app_notify_shift_family(NEW.organization_id, NEW.shift_id, 'FAMILY_CAREGIVER_ARRIVED', NEW.shift_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_arrival_notify_family() FROM PUBLIC;

-- ------------------------------------------------------------------ 4. offline departures (validation)
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
  PERFORM pg_advisory_xact_lock(hashtextextended('journey:' || NEW.shift_id::text, 0));
  SELECT id, status::text AS status, scheduled_start, scheduled_end INTO s
  FROM public.shifts WHERE id = NEW.shift_id AND organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_FOUND' USING ERRCODE = '23514'; END IF;
  IF s.status <> 'confirmed' THEN RAISE EXCEPTION 'JOURNEY_SHIFT_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                 AND a.organization_worker_membership_id = NEW.organization_worker_membership_id AND a.response_status = 'accepted') THEN
    RAISE EXCEPTION 'JOURNEY_ASSIGNMENT_NOT_ACCEPTED' USING ERRCODE = '23514';
  END IF;
  -- never in the future; a phone without signal may sync up to 12 h later (was 60 min)
  IF NEW.occurred_at > now() + interval '1 minute' OR NEW.occurred_at < now() - interval '12 hours' THEN
    RAISE EXCEPTION 'JOURNEY_TIME_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at < s.scheduled_start - interval '2 hours' OR NEW.occurred_at > s.scheduled_start + interval '1 hour' THEN
    RAISE EXCEPTION 'JOURNEY_OUTSIDE_WINDOW' USING ERRCODE = '23514';
  END IF;
  -- after the caregiver arrived or started, a departure/delay can no longer be added --
  -- unless it happened BEFORE that arrival (an offline record synced late, kept as history)
  IF EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = NEW.shift_id AND sa.organization_id = NEW.organization_id
             AND sa.occurred_at <= NEW.occurred_at)
     OR EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = NEW.shift_id
                AND ve.organization_id = NEW.organization_id AND ve.event_type = 'check_in' AND ve.occurred_at <= NEW.occurred_at)
     OR (NEW.event_type = 'DELAY_REPORTED' AND (
           EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = NEW.shift_id AND sa.organization_id = NEW.organization_id)
        OR EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = NEW.shift_id
                   AND ve.organization_id = NEW.organization_id AND ve.event_type = 'check_in'))) THEN
    RAISE EXCEPTION 'JOURNEY_ALREADY_ARRIVED' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'DELAY_REPORTED' THEN
    SELECT count(*) INTO delays FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED' AND organization_worker_membership_id = NEW.organization_worker_membership_id;
    IF delays >= 3 THEN RAISE EXCEPTION 'JOURNEY_DELAY_LIMIT' USING ERRCODE = '23514'; END IF;
    SELECT declared_delay_minutes, delay_reason INTO last_delay FROM public.shift_journey_events
    WHERE shift_id = NEW.shift_id AND event_type = 'DELAY_REPORTED' AND organization_worker_membership_id = NEW.organization_worker_membership_id
    ORDER BY occurred_at DESC, created_at DESC LIMIT 1;
    IF FOUND AND last_delay.declared_delay_minutes = NEW.declared_delay_minutes AND last_delay.delay_reason = NEW.delay_reason THEN
      RAISE EXCEPTION 'JOURNEY_DELAY_UNCHANGED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------ 5. late alert respects the declared delay
-- Latest delay declared by the caregiver who currently holds the accepted assignment.
CREATE OR REPLACE FUNCTION app_shift_declared_delay_minutes(p_org uuid, p_shift uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT e.declared_delay_minutes::integer FROM public.shift_journey_events e
    JOIN public.assignments a ON a.shift_id = e.shift_id AND a.organization_id = e.organization_id
     AND a.organization_worker_membership_id = e.organization_worker_membership_id AND a.response_status = 'accepted'
    WHERE e.shift_id = p_shift AND e.organization_id = p_org AND e.event_type = 'DELAY_REPORTED'
    ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1), 0);
$$;
REVOKE ALL ON FUNCTION app_shift_declared_delay_minutes(uuid, uuid) FROM PUBLIC;

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
      AND public.app_org_feature_enabled(s.organization_id, 'EN_CAMINO')   -- 108: pilot agencies only
      AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
                  AND a.response_status IN ('pending', 'accepted'))
      AND NOT EXISTS (SELECT 1 FROM public.shift_arrivals sa WHERE sa.shift_id = s.id AND sa.organization_id = s.organization_id)
      AND NOT EXISTS (SELECT 1 FROM public.verification_events ve WHERE ve.shift_id = s.id
                      AND ve.organization_id = s.organization_id AND ve.event_type = 'check_in')
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.related_entity_id = s.id AND n.notification_type = 'SHIFT_LATE_ARRIVAL')
      -- a declared delay moves the alert: start + delay + 15 min
      AND now() >= s.scheduled_start + interval '15 minutes'
                   + make_interval(mins => public.app_shift_declared_delay_minutes(s.organization_id, s.id))
  LOOP
    total := total + public.app_notify_shift_managers(late.organization_id, late.id, 'SHIFT_LATE_ARRIVAL');
  END LOOP;
  RETURN total;
END;
$$;

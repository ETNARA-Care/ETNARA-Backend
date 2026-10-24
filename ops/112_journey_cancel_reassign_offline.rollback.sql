-- ROLLBACK of migration 112 (En Camino: cancel/reassign notices, offline journey).
--
-- Use only if 112 blocks a legitimate flow. Rolling the frontend back alone is
-- safe with 112 in place (the new notices simply show the generic bell text).
-- Removes the new triggers, functions and index, and restores the exact previous
-- definitions (106 / 107 / 108), verified by diffing pg_get_functiondef and
-- triggers against a database that never had 112. Notifications already sent are
-- kept (they are user-visible history). Does not touch other data.
-- Run as the database owner in one transaction:
--   psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/112_journey_cancel_reassign_offline.rollback.sql
-- schema_migrations keeps its 112 row on purpose: the next deploy must NOT
-- silently re-apply it; re-apply manually with psql -f once the cause is fixed.

-- A. New triggers and functions
DROP TRIGGER IF EXISTS shifts_cancel_notify ON shifts;
DROP TRIGGER IF EXISTS assignment_removal_notify ON assignment_removal_audit;
DROP TRIGGER IF EXISTS assignments_delete_closes_alerts ON assignments;
DROP FUNCTION IF EXISTS app_shift_cancel_notify();
DROP FUNCTION IF EXISTS app_assignment_removal_notify();
DROP FUNCTION IF EXISTS app_assignment_delete_closes_alerts();
DROP INDEX IF EXISTS idx_notifications_shift_cancelled_once;

-- B. Previous definitions (106: journey/arrival notices, 107: validation with
--    the 60-minute offline limit, 108: late-arrival job with the EN_CAMINO gate)
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

-- C. Helpers used only by the 112 versions above (now unreferenced)
DROP FUNCTION IF EXISTS app_journey_event_is_stale(uuid, uuid, timestamptz, boolean);
DROP FUNCTION IF EXISTS app_shift_declared_delay_minutes(uuid, uuid);

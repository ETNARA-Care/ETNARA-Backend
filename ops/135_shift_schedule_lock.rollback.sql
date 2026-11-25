-- Rollback of 135 (bloqueo de horario al comenzar + corrección excepcional).
-- Restores the 107 guard (only «En camino» / «Llegué» lock the schedule) and removes the
-- correction function. The correction history is KEPT: the table is renamed, never
-- dropped (it is an audit record); audit_log rows stay. Then redeploy the previous build
-- (the 135 code calls app_correct_shift_schedule).
BEGIN;
CREATE OR REPLACE FUNCTION public.app_shift_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- Status: a cancelled shift never comes back (it could revive a cancelled
  -- SmartMatch link, journey and alerts); a completed one only re-opens through a
  -- check-in (several caregivers on one shift).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
      RAISE EXCEPTION 'SHIFT_STATUS_COMPLETED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Non-managers (caregivers) may only change the status.
  IF current_user = 'app_runtime' AND NOT public.app_is_org_manager() AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.service_location_id IS DISTINCT FROM OLD.service_location_id
    OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_FIELDS_LOCKED' USING ERRCODE = '42501';
  END IF;
  -- Once the caregiver declared the departure or arrived, the visit cannot be
  -- moved (a stale «En camino» would be shown and alerts suppressed): cancel it
  -- and create a new one instead.
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND (EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.shift_arrivals a WHERE a.shift_id = OLD.id)) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS app_correct_shift_schedule(uuid, timestamptz, timestamptz, text);
ALTER TABLE shift_schedule_corrections RENAME TO shift_schedule_corrections_rolled_back_135;
ALTER INDEX shift_schedule_corrections_shift RENAME TO shift_schedule_corrections_rolled_back_135_shift;
ALTER TABLE shift_schedule_corrections_rolled_back_135 RENAME CONSTRAINT shift_schedule_corrections_pkey TO shift_schedule_corrections_rolled_back_135_pkey;
DELETE FROM schema_migrations WHERE filename = '135_shift_schedule_lock.sql';
COMMIT;

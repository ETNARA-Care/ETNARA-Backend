-- 135: Bloqueo de horario al comenzar el turno + corrección excepcional (auditoría B4,
-- decisión de Rafa del 27-oct-2026). Builds on 133 (audit + notice of every change).
--
-- 1. Ordinary schedule changes (PATCH /shifts/:id, establishment administrator) are
--    refused once the shift has STARTED -- its start time passed, any check-in, status
--    in_progress / completed -- or was cancelled, whether or not «Llegué» was recorded.
--    Before the start nothing changes: administradora and supervisora may move it.
-- 2. Exceptional correction after the start: app_correct_shift_schedule() --
--    ORGANIZATION_ADMIN only, a reason of 10+ characters, never a cancelled shift. It
--    writes an append-only row in shift_schedule_corrections (previous and new times,
--    reason, who, when), an audit_log row SHIFT_SCHEDULE_CORRECTED with the reason, and
--    then moves the shift; the 133 trigger adds SHIFT_RESCHEDULED (audit) and notifies
--    the caregivers. Check-in / check-out / arrival records are NEVER touched: the
--    original clock-ins stay exactly as they were.
-- No change to existing rows. Rollback: ops/135_shift_schedule_lock.rollback.sql

CREATE TABLE shift_schedule_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  previous_start timestamptz NOT NULL,
  previous_end timestamptz NOT NULL,
  new_start timestamptz NOT NULL,
  new_end timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  corrected_by_user_id uuid REFERENCES users(id),
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CHECK (new_start < new_end)
);
CREATE INDEX shift_schedule_corrections_shift ON shift_schedule_corrections (shift_id, corrected_at);
CREATE TRIGGER shift_schedule_corrections_append_only BEFORE UPDATE OR DELETE ON shift_schedule_corrections
  FOR EACH ROW EXECUTE FUNCTION app_history_append_only();
ALTER TABLE shift_schedule_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_schedule_corrections FORCE ROW LEVEL SECURITY;
GRANT SELECT ON shift_schedule_corrections TO app_runtime;
-- Managers of the agency read the history; nobody inserts directly (only the function).
CREATE POLICY shift_schedule_corrections_manager_read ON shift_schedule_corrections
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON shift_schedule_corrections
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- 1 -------------------------------------------------------------------------------
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
          OR EXISTS (SELECT 1 FROM public.shift_arrivals a WHERE a.shift_id = OLD.id))
     AND NOT EXISTS (
       SELECT 1 FROM public.shift_schedule_corrections c
       WHERE c.id::text = current_setting('app.shift_schedule_correction', true)
         AND c.shift_id = OLD.id AND c.corrected_at = now()
         AND c.new_start = NEW.scheduled_start AND c.new_end = NEW.scheduled_end) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  -- 135 (auditoría B4): once the shift has STARTED (its start time passed, any check-in,
  -- or it is in progress / completed) or was cancelled, the ordinary schedule change is
  -- refused, «Llegué» or not. Only app_correct_shift_schedule() may move it: an
  -- administrator, with a reason, recorded in shift_schedule_corrections in this same
  -- transaction (the row must match the new times exactly).
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND (OLD.scheduled_start <= now()
          OR OLD.status IN ('in_progress', 'completed', 'cancelled')
          OR EXISTS (SELECT 1 FROM public.verification_events v WHERE v.shift_id = OLD.id AND v.event_type = 'check_in'))
     AND NOT EXISTS (
       SELECT 1 FROM public.shift_schedule_corrections c
       WHERE c.id::text = current_setting('app.shift_schedule_correction', true)
         AND c.shift_id = OLD.id AND c.corrected_at = now()
         AND c.new_start = NEW.scheduled_start AND c.new_end = NEW.scheduled_end) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- 2 -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_correct_shift_schedule(
  p_shift_id uuid, p_start timestamptz, p_end timestamptz, p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_shift record;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL OR public.app_is_superadmin() OR NOT public.app_is_org_admin() THEN
    RAISE EXCEPTION 'SHIFT_CORRECTION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT id, organization_id, scheduled_start, scheduled_end, status INTO v_shift
    FROM public.shifts WHERE id = p_shift_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_shift.status = 'cancelled' THEN RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start >= p_end THEN RAISE EXCEPTION 'SHIFT_CORRECTION_INVALID_TIMES' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'SHIFT_CORRECTION_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_start = v_shift.scheduled_start AND p_end = v_shift.scheduled_end THEN
    RAISE EXCEPTION 'SHIFT_CORRECTION_NO_CHANGE' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.shift_schedule_corrections (organization_id, shift_id, previous_start, previous_end, new_start, new_end, reason, corrected_by_user_id)
  VALUES (v_org, p_shift_id, v_shift.scheduled_start, v_shift.scheduled_end, p_start, p_end, btrim(p_reason), v_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (v_actor, v_org, 'SHIFT_SCHEDULE_CORRECTED', 'shift', p_shift_id,
          jsonb_build_object('scheduledStart', v_shift.scheduled_start, 'scheduledEnd', v_shift.scheduled_end),
          jsonb_build_object('scheduledStart', p_start, 'scheduledEnd', p_end, 'reason', btrim(p_reason), 'correctionId', v_id));

  PERFORM set_config('app.shift_schedule_correction', v_id::text, true);
  UPDATE public.shifts SET scheduled_start = p_start, scheduled_end = p_end, updated_at = now() WHERE id = p_shift_id;
  PERFORM set_config('app.shift_schedule_correction', '', true);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app_correct_shift_schedule(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_correct_shift_schedule(uuid, timestamptz, timestamptz, text) TO app_runtime;

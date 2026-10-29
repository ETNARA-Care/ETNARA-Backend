-- 133: Cambios de horario auditados y avisados (auditoría B4, 27-oct-2026).
--
-- When an authorized person changes scheduled_start or scheduled_end of a shift, the
-- database itself (trigger, so every path is covered: agency, supervisor, establishment
-- administrator, future tools):
--   * writes ONE audit_log row: action SHIFT_RESCHEDULED, actor = the session user
--     (app.current_user_id; NULL for operator maintenance), previous and new times.
--     Times only: no names, no address, no notes.
--   * notifies, in the app, every caregiver whose assignment on that shift is pending
--     or accepted and whose caregiver membership is active (SHIFT_RESCHEDULED).
--     Rejected or removed caregivers, family and other agencies are not notified.
-- Nothing happens when the times do not change (status-only updates, same values) or
-- when the shift is cancelled (cancelled shifts cannot be moved, 107).
-- Who may change a schedule is unchanged (managers in code + RLS; 107 locks shifts
-- whose journey/arrival started).
--
-- No table changes, no data changes. Rollback: ops/133_shift_reschedule_audit.rollback.sql

CREATE OR REPLACE FUNCTION app_shift_reschedule_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF NEW.status = 'cancelled'
     OR (NEW.scheduled_start IS NOT DISTINCT FROM OLD.scheduled_start
         AND NEW.scheduled_end IS NOT DISTINCT FROM OLD.scheduled_end) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (v_actor, NEW.organization_id, 'SHIFT_RESCHEDULED', 'shift', NEW.id,
          jsonb_build_object('scheduledStart', OLD.scheduled_start, 'scheduledEnd', OLD.scheduled_end),
          jsonb_build_object('scheduledStart', NEW.scheduled_start, 'scheduledEnd', NEW.scheduled_end));

  INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                    related_entity_id, care_recipient_id, channel, status, sent_at)
  SELECT DISTINCT w.user_id, NEW.organization_id, 'SHIFT_RESCHEDULED', 'shift', NEW.id, NULL::uuid, 'in_app', 'sent', now()
  FROM public.assignments a
  JOIN public.organization_worker_memberships owm
    ON owm.id = a.organization_worker_membership_id AND owm.organization_id = a.organization_id AND owm.status = 'active'
  JOIN public.workers w ON w.id = owm.worker_id
  WHERE a.shift_id = NEW.id AND a.organization_id = NEW.organization_id
    AND a.response_status IN ('pending', 'accepted')
    AND w.user_id IS NOT NULL
    AND w.user_id IS DISTINCT FROM v_actor
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_reschedule_audit() FROM PUBLIC;

DROP TRIGGER IF EXISTS shifts_reschedule_audit ON shifts;
CREATE TRIGGER shifts_reschedule_audit
  AFTER UPDATE OF scheduled_start, scheduled_end ON shifts
  FOR EACH ROW
  EXECUTE FUNCTION app_shift_reschedule_audit();

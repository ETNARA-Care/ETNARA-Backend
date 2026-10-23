-- Migration 098: SmartMatch Gate 5 -- in-app notifications.
--
-- Notifications are derived from the append-only SmartMatch history
-- (smartmatch_application_events, migration 096): every history row is a
-- persistent event, written exactly once per status change, so each
-- notification is produced exactly once. A partial unique index makes the
-- insert idempotent even if an event were ever replayed.
--
--   SUBMITTED  -> every active ORGANIZATION_ADMIN of the application's own
--                 agency (never the applicant, never another agency, never
--                 supervisors or the platform)
--   APPROVED   -> the caregiver
--   REJECTED   -> the caregiver (AGENCY_REJECTED), or
--                 the caregiver as "closed" (OPPORTUNITY_FILLED)
--   WITHDRAWN  -> no new notification
-- When an application is decided or withdrawn, the administrators' pending
-- "new application" notifications for it are marked read: the action they
-- asked for has been taken (by them, a colleague, or the caregiver).
--
-- Notifications reuse the existing table and endpoints (/me/notifications).
-- They carry only the application id: no patient, clinical, address or
-- caregiver profile data. care_recipient_id is always NULL.

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_smartmatch_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE related_entity_type = 'smartmatch_application';

CREATE OR REPLACE FUNCTION public.app_smartmatch_notify_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.event_type = 'SUBMITTED' THEN
    INSERT INTO public.notifications (
      user_id, organization_id, notification_type, related_entity_type,
      related_entity_id, channel, status, sent_at
    )
    SELECT DISTINCT om.user_id, NEW.organization_id, 'SMARTMATCH_APPLICATION_SUBMITTED',
           'smartmatch_application', NEW.application_id, 'in_app', 'sent', now()
    FROM public.organization_memberships om
    JOIN public.user_roles ur
      ON ur.organization_membership_id = om.id
     AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.organization_id = NEW.organization_id
      AND om.status = 'active'
      AND r.code = 'ORGANIZATION_ADMIN'
      AND om.user_id <> NEW.caregiver_user_id
    ON CONFLICT (user_id, notification_type, related_entity_id)
      WHERE related_entity_type = 'smartmatch_application'
    DO NOTHING;
    RETURN NULL;
  END IF;

  -- Decided or withdrawn: the administrators' request for action is resolved.
  UPDATE public.notifications
     SET read_at = now()
   WHERE related_entity_type = 'smartmatch_application'
     AND related_entity_id = NEW.application_id
     AND notification_type = 'SMARTMATCH_APPLICATION_SUBMITTED'
     AND read_at IS NULL;

  v_type := CASE
    WHEN NEW.event_type = 'APPROVED' THEN 'SMARTMATCH_APPLICATION_APPROVED'
    WHEN NEW.event_type = 'REJECTED' AND NEW.decision_reason = 'OPPORTUNITY_FILLED'
      THEN 'SMARTMATCH_APPLICATION_CLOSED'
    WHEN NEW.event_type = 'REJECTED' THEN 'SMARTMATCH_APPLICATION_REJECTED'
    ELSE NULL
  END;
  IF v_type IS NOT NULL THEN
    INSERT INTO public.notifications (
      user_id, organization_id, notification_type, related_entity_type,
      related_entity_id, channel, status, sent_at
    ) VALUES (
      NEW.caregiver_user_id, NEW.organization_id, v_type,
      'smartmatch_application', NEW.application_id, 'in_app', 'sent', now()
    )
    ON CONFLICT (user_id, notification_type, related_entity_id)
      WHERE related_entity_type = 'smartmatch_application'
    DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_notify_on_event() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_smartmatch_notify_on_event ON smartmatch_application_events;
CREATE TRIGGER trg_smartmatch_notify_on_event
  AFTER INSERT ON smartmatch_application_events
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_notify_on_event();

-- Migration 044: resolve assignment notifications to their shift safely.
--
-- Notification rows deliberately keep the assignment id as their audited
-- related entity.  The UI needs the corresponding shift id for navigation,
-- but a user-scoped notification request does not set an organization context
-- and therefore cannot query assignments through tenant RLS directly.
-- This narrow helper exposes only the shift id and only when the notification
-- belongs to the current authenticated user.

CREATE OR REPLACE FUNCTION app_notification_assignment_shift_id(
    p_notification_id uuid
)
RETURNS uuid AS $$
    SELECT a.shift_id
    FROM notifications n
    JOIN assignments a
      ON a.id = n.related_entity_id
     AND a.organization_id = n.organization_id
    WHERE n.id = p_notification_id
      AND n.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND n.related_entity_type = 'assignment'
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notification_assignment_shift_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notification_assignment_shift_id(uuid) TO app_runtime;

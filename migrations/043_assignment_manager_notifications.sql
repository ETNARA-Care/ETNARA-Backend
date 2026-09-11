-- Migration 043: deliver caregiver assignment responses to organization managers.
--
-- The caregiver legitimately updates their own assignment under RLS, but that
-- same worker context cannot enumerate privileged organization memberships.
-- Keep that enumeration behind a narrowly-scoped SECURITY DEFINER function
-- that validates the completed response before inserting any notification.

CREATE OR REPLACE FUNCTION app_notify_assignment_managers(
    p_assignment_id uuid,
    p_notification_type text
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_actor_user_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_expected_response text;
    v_care_recipient_id uuid;
    v_inserted integer := 0;
BEGIN
    v_expected_response := CASE p_notification_type
        WHEN 'SHIFT_ASSIGNMENT_ACCEPTED' THEN 'accepted'
        WHEN 'SHIFT_ASSIGNMENT_REJECTED' THEN 'rejected'
        ELSE NULL
    END;

    IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR v_expected_response IS NULL THEN
        RAISE EXCEPTION 'assignment manager notification is not authorized'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.care_recipient_id
      INTO v_care_recipient_id
      FROM assignments a
      JOIN organization_worker_memberships owm
        ON owm.id = a.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
     WHERE a.id = p_assignment_id
       AND a.organization_id = v_organization_id
       AND a.response_status = v_expected_response
       AND owm.organization_id = v_organization_id
       AND owm.status = 'active'
       AND w.user_id = v_actor_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'assignment manager notification is not authorized'
            USING ERRCODE = '42501';
    END IF;

    WITH inserted AS (
        INSERT INTO notifications (
            user_id,
            organization_id,
            notification_type,
            related_entity_type,
            related_entity_id,
            care_recipient_id,
            channel,
            status,
            sent_at
        )
        SELECT DISTINCT
            om.user_id,
            v_organization_id,
            p_notification_type,
            'assignment',
            p_assignment_id,
            v_care_recipient_id,
            'in_app',
            'sent',
            now()
        FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.organization_id = v_organization_id
          AND om.status = 'active'
          AND om.user_id <> v_actor_user_id
          AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
          AND NOT EXISTS (
              SELECT 1
              FROM notifications existing
              WHERE existing.user_id = om.user_id
                AND existing.organization_id = v_organization_id
                AND existing.notification_type = p_notification_type
                AND existing.related_entity_type = 'assignment'
                AND existing.related_entity_id = p_assignment_id
          )
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_inserted FROM inserted;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notify_assignment_managers(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_assignment_managers(uuid, text) TO app_runtime;

-- Migration 080: caregiver credential review queue notifications.
-- A caregiver may notify only managers of the organization in the current
-- tenant context, and only for a credential that belongs to their own worker
-- record (or when the actor is already an organization manager).

CREATE OR REPLACE FUNCTION app_notify_credential_review_managers(
    p_credential_id uuid
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_current_user_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_worker_id uuid;
    v_inserted integer := 0;
BEGIN
    IF v_organization_id IS NULL OR v_current_user_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT c.worker_id INTO v_worker_id
    FROM credentials c
    JOIN organization_worker_memberships owm
      ON owm.worker_id = c.worker_id
     AND owm.organization_id = v_organization_id
     AND owm.status = 'active'
    WHERE c.id = p_credential_id
    LIMIT 1;

    IF v_worker_id IS NULL THEN
        RETURN 0;
    END IF;

    IF NOT app_is_org_manager()
       AND NOT EXISTS (
          SELECT 1 FROM workers w
          WHERE w.id = v_worker_id
            AND w.user_id = v_current_user_id
       ) THEN
        RETURN 0;
    END IF;

    WITH manager_users AS (
        SELECT DISTINCT om.user_id
        FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.organization_id = v_organization_id
          AND om.status = 'active'
          AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    ), inserted AS (
        INSERT INTO notifications (
            user_id, organization_id, notification_type, related_entity_type,
            related_entity_id, channel, status, sent_at
        )
        SELECT mu.user_id, v_organization_id, 'CREDENTIAL_REVIEW_PENDING',
               'credential', p_credential_id, 'in_app', 'sent', now()
        FROM manager_users mu
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_inserted FROM inserted;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notify_credential_review_managers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_credential_review_managers(uuid) TO app_runtime;

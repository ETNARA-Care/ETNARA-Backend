-- Migration 048: one actionable expiry notice per manager and credential.
-- Notifications retain the credential as their audited related entity; a
-- narrow helper resolves the organization worker membership used by the UI.

CREATE UNIQUE INDEX idx_notifications_credential_expiry_once
    ON notifications (user_id, notification_type, related_entity_id)
    WHERE related_entity_type = 'credential'
      AND notification_type IN ('CREDENTIAL_EXPIRING', 'CREDENTIAL_EXPIRED');

CREATE OR REPLACE FUNCTION app_notify_credential_expiry_managers(
    p_worker_id uuid
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_inserted integer := 0;
BEGIN
    IF v_organization_id IS NULL OR NOT (app_is_org_manager() OR app_is_superadmin()) THEN
        RETURN 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM organization_worker_memberships owm
        WHERE owm.organization_id = v_organization_id
          AND owm.worker_id = p_worker_id
          AND owm.status = 'active'
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
    ), expiring_credentials AS (
        SELECT c.id,
               CASE WHEN c.expires_at < current_date
                    THEN 'CREDENTIAL_EXPIRED'
                    ELSE 'CREDENTIAL_EXPIRING'
               END AS notification_type
        FROM credentials c
        WHERE c.worker_id = p_worker_id
          AND c.status <> 'revoked'
          AND c.expires_at IS NOT NULL
          AND c.expires_at <= current_date + 30
    ), inserted AS (
        INSERT INTO notifications (
            user_id, organization_id, notification_type, related_entity_type,
            related_entity_id, channel, status, sent_at
        )
        SELECT mu.user_id, v_organization_id, ec.notification_type, 'credential',
               ec.id, 'in_app', 'sent', now()
        FROM manager_users mu
        CROSS JOIN expiring_credentials ec
        ON CONFLICT DO NOTHING
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_inserted FROM inserted;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notify_credential_expiry_managers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_credential_expiry_managers(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION app_notification_credential_membership_id(
    p_notification_id uuid
)
RETURNS uuid AS $$
    SELECT owm.id
    FROM notifications n
    JOIN credentials c ON c.id = n.related_entity_id
    JOIN organization_worker_memberships owm
      ON owm.worker_id = c.worker_id
     AND owm.organization_id = n.organization_id
    WHERE n.id = p_notification_id
      AND n.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND n.related_entity_type = 'credential'
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notification_credential_membership_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notification_credential_membership_id(uuid) TO app_runtime;

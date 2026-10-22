-- Migration 081: notify a caregiver when their credential review is decided.
-- This helper is intentionally narrow: only an organization manager in the
-- current tenant may notify the user linked to the worker that owns the
-- reviewed credential. It does not expose manager membership lists or permit
-- arbitrary cross-user notification inserts.

CREATE OR REPLACE FUNCTION app_notify_credential_review_result(
    p_credential_id uuid,
    p_review_status text
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_worker_user_id uuid;
    v_notification_type text;
    v_inserted integer := 0;
BEGIN
    IF v_organization_id IS NULL OR NOT app_is_org_manager() THEN
        RETURN 0;
    END IF;

    IF p_review_status = 'approved' THEN
        v_notification_type := 'CREDENTIAL_REVIEW_APPROVED';
    ELSIF p_review_status = 'rejected' THEN
        v_notification_type := 'CREDENTIAL_REVIEW_REJECTED';
    ELSE
        RETURN 0;
    END IF;

    SELECT w.user_id INTO v_worker_user_id
    FROM credentials c
    JOIN workers w ON w.id = c.worker_id
    JOIN organization_worker_memberships owm
      ON owm.worker_id = w.id
     AND owm.organization_id = v_organization_id
     AND owm.status = 'active'
    WHERE c.id = p_credential_id
    LIMIT 1;

    IF v_worker_user_id IS NULL THEN
        RETURN 0;
    END IF;

    INSERT INTO notifications (
        user_id, organization_id, notification_type, related_entity_type,
        related_entity_id, channel, status, sent_at
    ) VALUES (
        v_worker_user_id, v_organization_id, v_notification_type,
        'credential', p_credential_id, 'in_app', 'sent', now()
    );

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notify_credential_review_result(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_credential_review_result(uuid, text) TO app_runtime;

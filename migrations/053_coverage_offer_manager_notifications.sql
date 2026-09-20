-- Migration 053: notify managers after a caregiver answers a coverage offer.
--
-- A worker can update their own offer under RLS, but cannot enumerate
-- privileged organization memberships. Keep that lookup behind a narrowly
-- scoped SECURITY DEFINER function that validates the completed response.

CREATE OR REPLACE FUNCTION app_notify_coverage_offer_managers(
    p_offer_id uuid,
    p_notification_type text
)
RETURNS integer AS $$
DECLARE
    v_organization_id uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
    v_actor_user_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_expected_response text;
    v_inserted integer := 0;
BEGIN
    v_expected_response := CASE p_notification_type
        WHEN 'OPEN_SHIFT_INTERESTED' THEN 'interested'
        WHEN 'OPEN_SHIFT_DECLINED' THEN 'declined'
        ELSE NULL
    END;

    IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR v_expected_response IS NULL THEN
        RAISE EXCEPTION 'coverage offer manager notification is not authorized'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1
      FROM coverage_offers offer
      JOIN organization_worker_memberships owm
        ON owm.id = offer.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
     WHERE offer.id = p_offer_id
       AND offer.organization_id = v_organization_id
       AND offer.response_status = v_expected_response
       AND owm.organization_id = v_organization_id
       AND owm.status = 'active'
       AND w.user_id = v_actor_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'coverage offer manager notification is not authorized'
            USING ERRCODE = '42501';
    END IF;

    WITH inserted AS (
        INSERT INTO notifications (
            user_id,
            organization_id,
            notification_type,
            related_entity_type,
            related_entity_id,
            channel,
            status,
            sent_at
        )
        SELECT DISTINCT
            om.user_id,
            v_organization_id,
            p_notification_type,
            'coverage_offer',
            p_offer_id,
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
                AND existing.related_entity_type = 'coverage_offer'
                AND existing.related_entity_id = p_offer_id
          )
        RETURNING 1
    )
    SELECT count(*)::integer INTO v_inserted FROM inserted;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION app_notify_coverage_offer_managers(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_coverage_offer_managers(uuid, text) TO app_runtime;

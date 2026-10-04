-- Harden worker-to-recipient authorization so historical assignments cannot preserve operational access.
CREATE OR REPLACE FUNCTION app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
        JOIN shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND a.response_status IN ('pending', 'accepted')
          AND s.status IN ('unassigned', 'confirmed', 'in_progress')
          AND s.scheduled_end > now()
          AND (
            a.care_recipient_id = p_care_recipient_id
            OR s.care_recipient_id = p_care_recipient_id
            OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(p_care_recipient_id))
          )
    );
$$ LANGUAGE sql STABLE;

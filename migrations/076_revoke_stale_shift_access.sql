-- Align shift-level worker authorization with the recipient lifecycle rules.
-- Historical assignments must not keep completed/cancelled/past shifts visible.
-- A checked-in accepted worker keeps access while the visit is genuinely open.
CREATE OR REPLACE FUNCTION app_worker_has_shift_assignment(p_shift_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm
          ON a.organization_worker_membership_id = owm.id
        JOIN shifts s
          ON s.id = a.shift_id
         AND s.organization_id = a.organization_id
        WHERE a.shift_id = p_shift_id
          AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND a.response_status IN ('pending', 'accepted')
          AND s.status IN ('unassigned', 'confirmed', 'in_progress')
          AND (
            s.scheduled_end > now()
            OR (
              a.response_status = 'accepted'
              AND s.status = 'in_progress'
              AND EXISTS (
                SELECT 1
                FROM verification_events check_in
                WHERE check_in.organization_id = a.organization_id
                  AND check_in.shift_id = a.shift_id
                  AND check_in.organization_worker_membership_id = a.organization_worker_membership_id
                  AND check_in.event_type = 'check_in'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM verification_events check_out
                    WHERE check_out.organization_id = check_in.organization_id
                      AND check_out.shift_id = check_in.shift_id
                      AND check_out.organization_worker_membership_id = check_in.organization_worker_membership_id
                      AND check_out.event_type = 'check_out'
                      AND check_out.occurred_at > check_in.occurred_at
                  )
              )
            )
          )
    );
$$ LANGUAGE sql STABLE;

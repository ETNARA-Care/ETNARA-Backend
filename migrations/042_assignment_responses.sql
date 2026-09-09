-- Migration 042: explicit caregiver response to a shift assignment.
-- Existing assignments predate this workflow and remain accepted so active
-- staging/demo shifts keep working. Every new assignment starts pending.

ALTER TABLE assignments ADD COLUMN response_status text;
ALTER TABLE assignments ADD COLUMN responded_at timestamptz NULL;
ALTER TABLE assignments ADD COLUMN response_reason text NULL;

UPDATE assignments
SET response_status = 'accepted', responded_at = created_at
WHERE response_status IS NULL;

ALTER TABLE assignments ALTER COLUMN response_status SET DEFAULT 'pending';
ALTER TABLE assignments ALTER COLUMN response_status SET NOT NULL;
ALTER TABLE assignments ADD CONSTRAINT assignments_response_status_check
    CHECK (response_status IN ('pending', 'accepted', 'rejected'));

ALTER TABLE assignments DROP CONSTRAINT assignments_shift_membership_unique;
CREATE UNIQUE INDEX assignments_active_shift_membership_unique
    ON assignments (shift_id, organization_worker_membership_id)
    WHERE response_status IN ('pending', 'accepted');

CREATE OR REPLACE FUNCTION app_worker_has_shift_assignment(p_shift_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
        WHERE a.shift_id = p_shift_id
          AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND a.response_status IN ('pending', 'accepted')
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
    );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND a.response_status IN ('pending', 'accepted')
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND (
                a.care_recipient_id = p_care_recipient_id
                OR EXISTS (SELECT 1 FROM shifts s WHERE s.id = a.shift_id AND s.care_recipient_id = p_care_recipient_id)
                OR EXISTS (
                    SELECT 1 FROM shifts s
                    WHERE s.id = a.shift_id AND s.room_id IS NOT NULL
                      AND s.room_id = app_recipient_room_id(p_care_recipient_id)
                )
          )
    );
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS assignments_read ON assignments;
DROP POLICY IF EXISTS assignments_write ON assignments;

CREATE POLICY assignments_read ON assignments FOR SELECT
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
        app_is_org_manager()
        OR organization_worker_membership_id IN (
            SELECT owm.id FROM organization_worker_memberships owm
            WHERE owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
              AND owm.organization_id = assignments.organization_id
        )
    )
    OR app_is_superadmin()
);

CREATE POLICY assignments_insert_manager ON assignments FOR INSERT
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager() OR app_is_superadmin()
);

CREATE POLICY assignments_update_manager ON assignments FOR UPDATE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager() OR app_is_superadmin()
)
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager() OR app_is_superadmin()
);

CREATE POLICY assignments_update_assigned_worker ON assignments FOR UPDATE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND response_status = 'pending'
    AND organization_worker_membership_id IN (
        SELECT owm.id FROM organization_worker_memberships owm
        WHERE owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.organization_id = assignments.organization_id
    )
)
WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND response_status IN ('accepted', 'rejected')
    AND organization_worker_membership_id IN (
        SELECT owm.id FROM organization_worker_memberships owm
        WHERE owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.organization_id = assignments.organization_id
    )
);

CREATE POLICY assignments_delete_manager ON assignments FOR DELETE
USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND app_is_org_manager() OR app_is_superadmin()
);

-- Assignment notifications are generated only for the exact worker or an
-- active manager connected to the assignment.
DROP POLICY IF EXISTS notifications_insert ON notifications;
CREATE POLICY notifications_insert ON notifications FOR INSERT
WITH CHECK (
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR EXISTS (
        SELECT 1 FROM message_thread_participants mine
        JOIN message_thread_participants theirs ON theirs.message_thread_id = mine.message_thread_id
        WHERE mine.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND theirs.user_id = notifications.user_id
    )
    OR (
        notifications.care_recipient_id IS NOT NULL
        AND notifications.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_user_authorized_for_recipient(
            NULLIF(current_setting('app.current_user_id', true), '')::uuid,
            notifications.organization_id, notifications.care_recipient_id
        )
        AND app_user_authorized_for_recipient(
            notifications.user_id, notifications.organization_id, notifications.care_recipient_id
        )
    )
    OR (
        notifications.related_entity_type = 'assignment'
        AND notifications.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM assignments a
            JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
            JOIN workers w ON w.id = owm.worker_id
            WHERE a.id = notifications.related_entity_id
              AND a.organization_id = notifications.organization_id
              AND (
                (app_is_org_manager() AND w.user_id = notifications.user_id)
                OR (
                  w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND EXISTS (
                    SELECT 1 FROM organization_memberships om
                    JOIN user_roles ur ON ur.organization_membership_id = om.id
                    JOIN roles r ON r.id = ur.role_id
                    WHERE om.user_id = notifications.user_id
                      AND om.organization_id = notifications.organization_id
                      AND om.status = 'active'
                      AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
                  )
                )
              )
        )
    )
    OR app_is_superadmin()
);

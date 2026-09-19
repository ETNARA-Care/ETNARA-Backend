-- Migration 049: Phase 7 care-plan authorization and active-version integrity
--
-- Care plans existed in the original schema as versioned JSON snapshots, but
-- their original tenant policy was too broad for an operational endpoint: any
-- active organization member (including Family) could satisfy it. Phase 7
-- narrows reads to managers and assigned workers, and writes to managers only.

DROP POLICY IF EXISTS care_plans_tenant_isolation ON care_plans;

CREATE UNIQUE INDEX IF NOT EXISTS care_plans_one_active_per_recipient
    ON care_plans (organization_id, care_recipient_id)
    WHERE status = 'active';

CREATE POLICY care_plans_manager_or_assigned_worker_read ON care_plans
    FOR SELECT
    USING (
        (
            organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND (
                app_is_org_manager()
                OR EXISTS (
                    SELECT 1
                    FROM workers w
                    JOIN organization_worker_memberships owm
                      ON owm.worker_id = w.id
                     AND owm.organization_id = care_plans.organization_id
                     AND owm.status = 'active'
                    JOIN assignments a
                      ON a.organization_worker_membership_id = owm.id
                     AND a.organization_id = care_plans.organization_id
                     AND a.response_status IN ('pending', 'accepted')
                    JOIN shifts s
                      ON s.id = a.shift_id
                     AND s.organization_id = care_plans.organization_id
                     AND s.status != 'cancelled'
                    WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                      AND (
                          s.care_recipient_id = care_plans.care_recipient_id
                          OR a.care_recipient_id = care_plans.care_recipient_id
                          OR (
                              s.room_id IS NOT NULL
                              AND s.room_id = (
                                  SELECT cr.room_id
                                  FROM care_recipients cr
                                  WHERE cr.id = care_plans.care_recipient_id
                                    AND cr.organization_id = care_plans.organization_id
                              )
                          )
                      )
                )
            )
        )
        OR app_is_superadmin()
    );

CREATE POLICY care_plans_manager_insert ON care_plans
    FOR INSERT
    WITH CHECK (
        (
            organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

CREATE POLICY care_plans_manager_update ON care_plans
    FOR UPDATE
    USING (
        (
            organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        (
            organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

-- Deliberately no DELETE policy: plan versions are audit history and are
-- superseded, never removed.

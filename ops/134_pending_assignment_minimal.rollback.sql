-- Rollback of 134 (asignación pendiente = datos mínimos). Functions and one policy only;
-- no data changes. Restores the pre-134 rules (pending assignments see the full record,
-- the care plan and the private instructions again). Then redeploy the previous backend
-- build (GET /me/shifts of 134 calls app_my_shift_preview).
BEGIN;
CREATE OR REPLACE FUNCTION public.app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
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
          AND (
            a.care_recipient_id = p_care_recipient_id
            OR s.care_recipient_id = p_care_recipient_id
            OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(p_care_recipient_id))
          )
    );
$function$;

DROP POLICY IF EXISTS shift_private_instructions_assigned_worker_read ON shift_private_instructions;
CREATE POLICY shift_private_instructions_assigned_worker_read ON shift_private_instructions
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_worker_has_shift_assignment(shift_id));

DROP FUNCTION IF EXISTS app_my_shift_preview(uuid);
DELETE FROM schema_migrations WHERE filename = '134_pending_assignment_minimal.sql';
COMMIT;

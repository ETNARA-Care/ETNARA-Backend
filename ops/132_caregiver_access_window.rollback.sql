-- Rollback of 132 (ventana de acceso de las cuidadoras). Functions and policies only;
-- no data is changed or removed. Restores the exact rules of 038 (messaging) and 100
-- (service addresses): pending assignments and past caregivers regain access.
-- If 134 is applied, roll back 134 FIRST (its policy uses app_worker_confirmed_shift_assignment).
-- Run as the migrations superuser, then redeploy the previous backend build
-- (the code of 132 calls app_user_can_message_recipient and app_worker_confirmed_shift_assignment).
BEGIN;
DROP POLICY IF EXISTS message_threads_read ON message_threads;
CREATE POLICY message_threads_read ON message_threads
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = message_threads.id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        AND (
            app_is_org_manager()
            OR care_recipient_id IS NULL
            OR app_user_authorized_for_recipient(
                NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                message_threads.organization_id,
                message_threads.care_recipient_id
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS message_threads_create ON message_threads;
CREATE POLICY message_threads_create ON message_threads
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (
                care_recipient_id IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_threads.organization_id,
                    message_threads.care_recipient_id
                )
            )
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS message_thread_participants_write ON message_thread_participants;
CREATE POLICY message_thread_participants_write ON message_thread_participants
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_is_org_manager()
            OR (
                user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
            OR (
                app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_authorized_for_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
                AND app_user_authorized_for_recipient(
                    message_thread_participants.user_id,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
        )
        OR app_is_superadmin()
    );


CREATE OR REPLACE FUNCTION app_worker_can_read_service_location(
  p_location_id uuid, p_recipient_id uuid, p_is_primary boolean, p_archived_at timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND s.care_recipient_id = p_recipient_id
      AND (s.service_location_id = p_location_id
           OR (s.service_location_id IS NULL AND p_is_primary AND p_archived_at IS NULL))
      AND public.app_worker_has_shift_assignment(s.id)
  );
$$;
REVOKE ALL ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) TO app_runtime;

DROP FUNCTION IF EXISTS app_my_message_recipients();
DROP FUNCTION IF EXISTS app_user_can_message_recipient(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_worker_messaging_window(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_worker_confirmed_shift_assignment(uuid);
DELETE FROM schema_migrations WHERE filename = '132_caregiver_access_window.sql';
COMMIT;

-- 132: Ventana de acceso de las cuidadoras (auditoría B4, decisiones de Rafa del 27-oct-2026).
--
-- No table changes, no data changes. Functions and three messaging policies only.
--
-- A. MENSAJERÍA. A caregiver may start, read and take part in the conversation about
--    a resident only while she has an ACCEPTED assignment on a confirmed / in-progress /
--    completed shift WITH THAT RESIDENT, and only until 24 h after that shift ended
--    (her own check-out as received by the server, or the scheduled end when there is
--    none). A visit still open (checked in, not out) keeps access. After the window she
--    loses the whole conversation, history included. Pending, rejected and cancelled
--    assignments never grant access. A shift with a DIFFERENT resident never extends it
--    (only shifts whose care_recipient_id is this resident, or room shifts without a
--    resident in this resident's room). Managers and family keep today's rules.
--    The old app_user_authorized_for_recipient() is NOT changed: it also drives
--    notifications, family reads and journey state, which are out of scope here.
--
-- B. DIRECCIONES. A caregiver reads a service address only through a shift for which
--    her assignment is ACCEPTED, the shift is confirmed or in progress, and it has not
--    ended (or her visit is still open). Pending assignments no longer qualify.
--    Family rules (can_view_service_location) are unchanged.
--
-- Rollback: ops/132_caregiver_access_window.rollback.sql (restores 038 / 100 exactly).

-- A.1 Caregiver messaging window (any user, so it can also vet participants) -------------
CREATE OR REPLACE FUNCTION app_worker_messaging_window(
  p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     AND EXISTS (
       SELECT 1
       FROM public.assignments a
       JOIN public.organization_worker_memberships owm
         ON owm.id = a.organization_worker_membership_id
        AND owm.organization_id = a.organization_id
        AND owm.status = 'active'
       JOIN public.workers w ON w.id = owm.worker_id AND w.user_id = p_user_id
       JOIN public.organization_memberships om
         ON om.user_id = p_user_id AND om.organization_id = a.organization_id AND om.status = 'active'
       JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
       WHERE a.organization_id = p_organization_id
         AND a.response_status = 'accepted'
         AND s.status IN ('confirmed', 'in_progress', 'completed')
         AND (
           s.care_recipient_id = p_care_recipient_id
           OR (s.care_recipient_id IS NULL
               AND (a.care_recipient_id = p_care_recipient_id
                    OR (s.room_id IS NOT NULL AND s.room_id = public.app_recipient_room_id(p_care_recipient_id))))
         )
         AND (
           -- her visit is open right now
           (s.status = 'in_progress' AND EXISTS (
              SELECT 1 FROM public.verification_events ci
              WHERE ci.organization_id = a.organization_id AND ci.shift_id = a.shift_id
                AND ci.organization_worker_membership_id = a.organization_worker_membership_id
                AND ci.event_type = 'check_in'
                AND NOT EXISTS (
                  SELECT 1 FROM public.verification_events co
                  WHERE co.organization_id = ci.organization_id AND co.shift_id = ci.shift_id
                    AND co.organization_worker_membership_id = ci.organization_worker_membership_id
                    AND co.event_type = 'check_out' AND co.occurred_at > ci.occurred_at)))
           -- or the shift has not ended, or ended less than 24 h ago
           OR now() < COALESCE(
                (SELECT max(co.created_at) FROM public.verification_events co
                  WHERE co.organization_id = a.organization_id AND co.shift_id = a.shift_id
                    AND co.organization_worker_membership_id = a.organization_worker_membership_id
                    AND co.event_type = 'check_out'),
                s.scheduled_end) + interval '24 hours'
         )
     );
$$;
REVOKE ALL ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) TO app_runtime;

-- A.2 Who may take part in the conversation about a resident --------------------------
-- Managers and family: same branches as app_user_authorized_for_recipient (038).
-- Caregivers: only the window above.
CREATE OR REPLACE FUNCTION app_user_can_message_recipient(
  p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
  AND EXISTS (SELECT 1 FROM public.care_recipients cr
              WHERE cr.id = p_care_recipient_id AND cr.organization_id = p_organization_id)
  AND (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      JOIN public.user_roles ur ON ur.organization_membership_id = om.id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE om.user_id = p_user_id AND om.organization_id = p_organization_id
        AND om.status = 'active' AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR'))
    OR EXISTS (
      SELECT 1 FROM public.family_relationships fr
      WHERE fr.user_id = p_user_id AND fr.organization_id = p_organization_id
        AND fr.care_recipient_id = p_care_recipient_id AND fr.status = 'active'
        AND EXISTS (
          SELECT 1 FROM public.user_roles ur
          JOIN public.organization_memberships om ON ur.organization_membership_id = om.id
          JOIN public.roles r ON ur.role_id = r.id
          WHERE om.user_id = p_user_id AND om.organization_id = p_organization_id
            AND om.status = 'active' AND r.code = 'FAMILY'))
    OR public.app_worker_messaging_window(p_user_id, p_organization_id, p_care_recipient_id)
  );
$$;
REVOKE ALL ON FUNCTION app_user_can_message_recipient(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_can_message_recipient(uuid, uuid, uuid) TO app_runtime;

-- A.2b People the SESSION user may start a conversation about (minimal fields).
-- SECURITY DEFINER so a caregiver inside her 24 h window still gets the name after her
-- check-out, when the care_recipients RLS no longer shows her the record.
CREATE OR REPLACE FUNCTION app_my_message_recipients()
RETURNS TABLE (id uuid, first_name text, last_name text, preferred_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT cr.id, cr.first_name::text, cr.last_name::text, cr.preferred_name::text
  FROM public.care_recipients cr
  WHERE cr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND cr.status = 'active'
    AND public.app_user_can_message_recipient(
          NULLIF(current_setting('app.current_user_id', true), '')::uuid, cr.organization_id, cr.id)
  ORDER BY cr.first_name, cr.last_name;
$$;
REVOKE ALL ON FUNCTION app_my_message_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_my_message_recipients() TO app_runtime;

-- A.3 Messaging policies: same shape as 038, new helper -----------------------------------
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
            OR app_user_can_message_recipient(
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
                AND app_user_can_message_recipient(
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
                AND app_user_can_message_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
            OR (
                app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id) IS NOT NULL
                AND app_user_can_message_recipient(
                    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
                AND app_user_can_message_recipient(
                    message_thread_participants.user_id,
                    message_thread_participants.organization_id,
                    app_thread_recipient_id(message_thread_participants.message_thread_id, message_thread_participants.organization_id)
                )
            )
        )
        OR app_is_superadmin()
    );

-- B.1 Caregiver with an ACCEPTED assignment on a current shift (session user) ------------
CREATE OR REPLACE FUNCTION app_worker_confirmed_shift_assignment(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.assignments a
    JOIN public.organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
    JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
    WHERE a.shift_id = p_shift_id
      AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND owm.worker_id IN (SELECT worker_id FROM public.app_current_worker_ids())
      AND owm.status = 'active'
      AND a.response_status = 'accepted'
      AND s.status IN ('confirmed', 'in_progress')
      AND (
        s.scheduled_end > now()
        OR (
          s.status = 'in_progress'
          AND EXISTS (
            SELECT 1 FROM public.verification_events ci
            WHERE ci.organization_id = a.organization_id AND ci.shift_id = a.shift_id
              AND ci.organization_worker_membership_id = a.organization_worker_membership_id
              AND ci.event_type = 'check_in'
              AND NOT EXISTS (
                SELECT 1 FROM public.verification_events co
                WHERE co.organization_id = ci.organization_id AND co.shift_id = ci.shift_id
                  AND co.organization_worker_membership_id = ci.organization_worker_membership_id
                  AND co.event_type = 'check_out' AND co.occurred_at > ci.occurred_at))
        )
      )
  );
$$;
REVOKE ALL ON FUNCTION app_worker_confirmed_shift_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_confirmed_shift_assignment(uuid) TO app_runtime;

-- B.2 Service-address RLS: same as 100, accepted assignments only ----------------------
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
      AND public.app_worker_confirmed_shift_assignment(s.id)
  );
$$;
REVOKE ALL ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) TO app_runtime;

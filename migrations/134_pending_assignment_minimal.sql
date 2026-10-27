-- 134: Asignación PENDIENTE = datos mínimos (auditoría B4, decisión de Rafa del 27-oct-2026).
--
-- Until the caregiver ACCEPTS, she only gets what she needs to decide: date and time
-- of the shift, the municipality of the service, and a short name of the person
-- (preferred name, or first name + initial of the last name). She does NOT get the
-- person's record (full name, birth date, allergies, routines), the care plan, the
-- shift's private instructions, the exact address (132), the conversations (132) or
-- the person's records, incidents and observations.
--
-- 1. app_worker_has_recipient_assignment(): accepted assignments only (was pending or
--    accepted). It drives the code checks and the RLS of care_recipients, care_events,
--    observations, incidents (+ timeline, attachments), so the whole record follows.
-- 2. Shift private instructions: assigned-worker read now requires an accepted, current
--    assignment (app_worker_confirmed_shift_assignment, 132).
-- 3. app_my_shift_preview(shift): the minimal preview of HER OWN pending or accepted
--    shift (short name, municipality); used by GET /me/shifts in both connection modes.
-- Shift metadata (times, status, her own assignment and verification) is unchanged, so
-- she can still open the shift and Accept / Reject. SmartMatch is unchanged: its
-- opportunities never carry personal data, and an approved application becomes a
-- normal pending assignment that the caregiver accepts.
-- Requires 132 (app_worker_confirmed_shift_assignment). No table or data changes.
-- Rollback: ops/134_pending_assignment_minimal.rollback.sql

-- 1 -------------------------------------------------------------------------------
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
          AND a.response_status = 'accepted'
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

-- 2 -------------------------------------------------------------------------------
DROP POLICY IF EXISTS shift_private_instructions_assigned_worker_read ON shift_private_instructions;
CREATE POLICY shift_private_instructions_assigned_worker_read ON shift_private_instructions
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_worker_confirmed_shift_assignment(shift_id));

-- 3 -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_my_shift_preview(p_shift_id uuid)
RETURNS TABLE (display_name text, municipality text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    CASE WHEN mine.response_status = 'accepted'
         THEN COALESCE(NULLIF(cr.preferred_name, ''), trim(cr.first_name || ' ' || cr.last_name))
         ELSE COALESCE(NULLIF(cr.preferred_name, ''),
                       trim(cr.first_name || ' ' || COALESCE(left(NULLIF(cr.last_name, ''), 1) || '.', '')))
    END::text,
    loc.municipality::text
  FROM public.shifts s
  JOIN LATERAL (
    SELECT a.response_status
    FROM public.assignments a
    JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id AND owm.status = 'active'
    WHERE a.shift_id = s.id AND a.organization_id = s.organization_id
      AND owm.worker_id IN (SELECT worker_id FROM public.app_current_worker_ids())
      AND a.response_status IN ('pending', 'accepted')
    ORDER BY (a.response_status = 'accepted') DESC
    LIMIT 1
  ) mine ON true
  LEFT JOIN public.care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
  LEFT JOIN LATERAL (
    SELECT l.municipality FROM public.care_recipient_locations l
    WHERE l.organization_id = s.organization_id AND l.care_recipient_id = s.care_recipient_id
      AND (l.id = s.service_location_id OR (s.service_location_id IS NULL AND l.is_primary AND l.archived_at IS NULL))
    LIMIT 1
  ) loc ON true
  WHERE s.id = p_shift_id
    AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND NOT public.app_is_superadmin();
$$;
REVOKE ALL ON FUNCTION app_my_shift_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_my_shift_preview(uuid) TO app_runtime;

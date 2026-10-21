-- Migration 081: break recursive RLS evaluation in
-- app_worker_has_shift_assignment(uuid).
--
-- Migration 076 redefined the helper so it also reads shifts and
-- verification_events. Both tables have worker policies that call this same
-- helper (shifts_worker_assigned_only, verification_events_worker_own_assignment).
-- Under app_runtime (SECURITY INVOKER, RLS enforced) the evaluation never ends.
-- Verified against PostgreSQL 16: a caregiver accepting a shift drove the
-- backend process out of memory, it was killed (signal 9) and the whole
-- server restarted, dropping every open connection.
--
-- Same remedy as migration 079: SECURITY DEFINER limited to this boolean
-- lookup. The caller cannot widen it: the organization comes only from
-- app.current_org_id and the worker only from app_current_worker_ids(), both
-- derived from the authenticated session. The body is unchanged from 076.
-- A fixed search_path prevents object shadowing inside the privileged function.

CREATE OR REPLACE FUNCTION public.app_worker_has_shift_assignment(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.assignments a
        JOIN public.organization_worker_memberships owm
          ON a.organization_worker_membership_id = owm.id
        JOIN public.shifts s
          ON s.id = a.shift_id
         AND s.organization_id = a.organization_id
        WHERE a.shift_id = p_shift_id
          AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM public.app_current_worker_ids())
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
                FROM public.verification_events check_in
                WHERE check_in.organization_id = a.organization_id
                  AND check_in.shift_id = a.shift_id
                  AND check_in.organization_worker_membership_id = a.organization_worker_membership_id
                  AND check_in.event_type = 'check_in'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM public.verification_events check_out
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
$$;

REVOKE ALL ON FUNCTION public.app_worker_has_shift_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_worker_has_shift_assignment(uuid) TO app_runtime;

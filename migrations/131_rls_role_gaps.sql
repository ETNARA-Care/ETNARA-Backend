-- 131: RLS role gaps found by the authorization matrix (auditoría 26-oct-2026, G1-G3).
--
-- Production still connects as a role that bypasses RLS, so nothing here changes
-- behaviour there. This makes the restricted app_runtime role (#226, etapa C)
-- support the same legitimate flows the application code already allows, and
-- closes two policies that let family or caregivers WRITE a person's profile or
-- care log through RLS. Additive and idempotent. No data is changed.
--
-- G1  A caregiver keeps reading her OWN visits after they end (schedule and
--     status of the shift, her own check-in/out and arrivals, and only the
--     name of the person). 076 stays in force: no access to the person's
--     profile, care plan or other caregivers' records after the visit.
-- G2  A caregiver keeps reading the care records she wrote herself.
-- G3  The administrator of an establishment manages the residents, shifts and
--     assignments of THAT establishment (what establishmentAccess and
--     establishmentPeople already do in code).
-- W   care_recipients and care_events: family and worker policies become
--     read-only (the code never lets them write these rows).

-- Helpers (SECURITY DEFINER: they read across tables without re-entering RLS,
-- which avoids policy recursion between shifts, assignments and care_recipients).

CREATE OR REPLACE FUNCTION public.app_worker_own_shift(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- An own assignment (pending or accepted) on a shift of the current
  -- organization that started at most 30 days ago or has not started yet.
  -- PROVISIONAL WINDOW (26-oct-2026): the caregiver's history is limited here,
  -- in one place. The approved future policy (24 h after the server-recorded end
  -- of her visit, after the pilot) replaces this function, the own-record
  -- policies below and the code/portal TOGETHER; never shorten it here alone, or
  -- the portal would show "Not found" for visits it still lists.
  -- Today the window applies to the shift (her visit list and the person's name);
  -- her own check-in/out and care records (verification_events_worker_own_read,
  -- care_events_worker_own_read) have no time limit while her membership is active.
  SELECT EXISTS (
    SELECT 1
    FROM public.assignments a
    JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
    WHERE a.shift_id = p_shift_id
      AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND a.response_status IN ('pending', 'accepted')
      AND public.app_is_own_worker_membership(a.organization_worker_membership_id)
      AND s.scheduled_start > now() - interval '30 days'
  );
$$;

CREATE OR REPLACE FUNCTION public.app_establishment_admin_for_recipient(p_recipient_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.care_recipients cr
    WHERE cr.id = p_recipient_id
      AND cr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND cr.location_id IS NOT NULL
      AND public.app_is_establishment_admin(cr.location_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.app_establishment_admin_for_shift(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = p_shift_id
      AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND s.care_recipient_id IS NOT NULL
      AND public.app_establishment_admin_for_recipient(s.care_recipient_id)
  );
$$;

REVOKE ALL ON FUNCTION public.app_worker_own_shift(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_establishment_admin_for_recipient(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_establishment_admin_for_shift(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_worker_own_shift(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_establishment_admin_for_recipient(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_establishment_admin_for_shift(uuid) TO app_runtime;

-- G1: the caregiver's own recent visits (schedule and status only)
DROP POLICY IF EXISTS shifts_worker_own_history_read ON shifts;
CREATE POLICY shifts_worker_own_history_read ON shifts
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_worker_own_shift(id));

-- G1: her own check-in/out events, whatever the shift's status
DROP POLICY IF EXISTS verification_events_worker_own_read ON verification_events;
CREATE POLICY verification_events_worker_own_read ON verification_events
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_is_own_worker_membership(organization_worker_membership_id));

-- G2: the care records she wrote herself
DROP POLICY IF EXISTS care_events_worker_own_read ON care_events;
CREATE POLICY care_events_worker_own_read ON care_events
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_is_own_worker_membership(organization_worker_membership_id));

-- G3: establishment administrators, limited to their establishment
DROP POLICY IF EXISTS care_recipients_establishment_admin ON care_recipients;
CREATE POLICY care_recipients_establishment_admin ON care_recipients
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND location_id IS NOT NULL
         AND public.app_is_establishment_admin(location_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND location_id IS NOT NULL
              AND public.app_is_establishment_admin(location_id));

DROP POLICY IF EXISTS shifts_establishment_admin_read ON shifts;
CREATE POLICY shifts_establishment_admin_read ON shifts
  FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND care_recipient_id IS NOT NULL
         AND public.app_establishment_admin_for_recipient(care_recipient_id));

DROP POLICY IF EXISTS shifts_establishment_admin_insert ON shifts;
CREATE POLICY shifts_establishment_admin_insert ON shifts
  FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND care_recipient_id IS NOT NULL
              AND public.app_establishment_admin_for_recipient(care_recipient_id));

DROP POLICY IF EXISTS assignments_establishment_admin_insert ON assignments;
CREATE POLICY assignments_establishment_admin_insert ON assignments
  FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND public.app_establishment_admin_for_shift(shift_id));

DROP POLICY IF EXISTS assignments_establishment_admin_delete ON assignments;
CREATE POLICY assignments_establishment_admin_delete ON assignments
  FOR DELETE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_establishment_admin_for_shift(shift_id));

-- G3: the assignment notice to the caregiver an establishment administrator just
-- assigned (same notice a manager sends; 038's recipient rule does not cover them).
DROP POLICY IF EXISTS notifications_insert_establishment_assignment ON notifications;
CREATE POLICY notifications_insert_establishment_assignment ON notifications
  FOR INSERT
  WITH CHECK (notification_type = 'SHIFT_ASSIGNMENT_PENDING'
              AND related_entity_type = 'assignment'
              AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND EXISTS (
                SELECT 1 FROM assignments a
                JOIN organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
                JOIN workers w ON w.id = owm.worker_id
                WHERE a.id = notifications.related_entity_id
                  AND a.organization_id = notifications.organization_id
                  AND w.user_id = notifications.user_id
                  AND public.app_establishment_admin_for_shift(a.shift_id)));

-- W: family and assigned caregivers read, never write, the profile and the care log.
-- Same USING as before; only the command changes from ALL to SELECT.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual FROM pg_policies
    WHERE schemaname = 'public'
      AND (tablename, policyname) IN (('care_recipients', 'care_recipients_family_specific'),
                                      ('care_recipients', 'care_recipients_worker_assigned_only'),
                                      ('care_events', 'care_events_family_specific'))
      AND cmd = 'ALL'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', r.policyname, r.tablename);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', r.policyname, r.tablename, r.qual);
  END LOOP;
END $$;

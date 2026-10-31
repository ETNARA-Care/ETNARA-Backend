-- 138: Establishment administrators cannot take over other caregivers or change agency-wide data
-- (auditoría 31-oct-2026, hallazgos C1 y C2).
--
-- C2 (RLS): before 138 any establishment administrator of an agency could write ANY caregiver
-- membership of that agency (organization_worker_memberships_staff_write used
-- app_is_any_establishment_admin) and attach any caregiver to her establishment
-- (establishment_worker_assignments_manager_insert/update). And any active member of the agency
-- (caregiver, family) could UPDATE any caregiver's global profile row (workers_self_or_shared_org
-- was FOR ALL). The code is fixed in the same PR; this closes the same paths at the database layer.
--
-- After 138:
--   - caregiver memberships and establishment staff assignments: written only by agency managers
--     (ORGANIZATION_ADMIN / SUPERVISOR) or the platform superadmin;
--   - global caregiver profile (workers): read as before; updated only by the caregiver herself or
--     an agency manager of an agency where she is active;
--   - the one thing an establishment administrator may still do with staff -- create a NEW caregiver
--     in her own establishment -- goes through app_establishment_create_worker (SECURITY DEFINER),
--     which checks she administers that establishment.
--
-- C1 (residents) needs no RLS change: care_recipients_establishment_admin already requires the
-- CURRENT location of the row to be one she administers (USING) and the new one too (CHECK), so
-- under app_runtime she cannot pull a resident from elsewhere. The code check is in the same PR.
--
-- Idempotent. No table or data changes. Production connects as postgres (RLS bypassed): the
-- policies only take effect when app_runtime is activated. Rollback: ops/138_establishment_admin_staff_scope.rollback.sql

-- 1. Caregiver memberships: managers only (was managers OR any establishment administrator).
DROP POLICY IF EXISTS organization_worker_memberships_staff_write ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_staff_write ON organization_worker_memberships
  FOR ALL
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND public.app_is_org_manager_definer())
         OR public.app_is_superadmin())
  WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
               AND public.app_is_org_manager_definer())
              OR public.app_is_superadmin());

-- 2. Establishment staff assignments: managers only (was managers OR that establishment's administrator).
DROP POLICY IF EXISTS establishment_worker_assignments_manager_insert ON establishment_worker_assignments;
CREATE POLICY establishment_worker_assignments_manager_insert ON establishment_worker_assignments
  FOR INSERT
  WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
               AND public.app_is_org_manager())
              OR public.app_is_superadmin());

DROP POLICY IF EXISTS establishment_worker_assignments_manager_update ON establishment_worker_assignments;
CREATE POLICY establishment_worker_assignments_manager_update ON establishment_worker_assignments
  FOR UPDATE
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND public.app_is_org_manager())
         OR public.app_is_superadmin())
  WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
               AND public.app_is_org_manager())
              OR public.app_is_superadmin());

-- 3. Global caregiver profile: the FOR ALL policy becomes SELECT (same rule) + a narrow UPDATE.
DROP POLICY IF EXISTS workers_self_or_shared_org ON workers;
CREATE POLICY workers_self_or_shared_org ON workers
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (EXISTS (SELECT 1 FROM organization_worker_memberships owm
                      WHERE owm.worker_id = workers.id
                        AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                        AND owm.status = 'active')
             AND public.app_has_active_membership())
         OR public.app_is_superadmin());

DROP POLICY IF EXISTS workers_self_or_manager_update ON workers;
CREATE POLICY workers_self_or_manager_update ON workers
  FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (EXISTS (SELECT 1 FROM organization_worker_memberships owm
                      WHERE owm.worker_id = workers.id
                        AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                        AND owm.status = 'active')
             AND public.app_is_org_manager_definer())
         OR public.app_is_superadmin())
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (EXISTS (SELECT 1 FROM organization_worker_memberships owm
                      WHERE owm.worker_id = workers.id
                        AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                        AND owm.status = 'active')
             AND public.app_is_org_manager_definer())
         OR public.app_is_superadmin());

-- 4. The establishment administrator's only staff write: a NEW caregiver in her own establishment.
CREATE OR REPLACE FUNCTION public.app_establishment_create_worker(p_location_id uuid, p_display_name text, p_internal_role text)
RETURNS TABLE (membership_id uuid, worker_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_worker uuid := gen_random_uuid();
  v_membership uuid := gen_random_uuid();
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'ESTABLISHMENT_MANAGEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND l.organization_id = v_org AND l.archived_at IS NULL)
     OR NOT public.app_is_establishment_admin(p_location_id) THEN
    RAISE EXCEPTION 'ESTABLISHMENT_MANAGEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_display_name IS NULL OR char_length(btrim(p_display_name)) NOT BETWEEN 1 AND 120
     OR p_internal_role IS NULL OR char_length(btrim(p_internal_role)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'INVALID_WORKER' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.workers (id, display_name) VALUES (v_worker, btrim(p_display_name));
  INSERT INTO public.organization_worker_memberships (id, worker_id, organization_id, internal_role)
    VALUES (v_membership, v_worker, v_org, btrim(p_internal_role));
  INSERT INTO public.establishment_worker_assignments (organization_id, location_id, organization_worker_membership_id, created_by_user_id)
    VALUES (v_org, p_location_id, v_membership, v_user);
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
    VALUES (v_user, v_org, v_org, 'ESTABLISHMENT_WORKER_CREATED', 'organization_worker_membership', v_membership,
            jsonb_build_object('location_id', p_location_id));
  RETURN QUERY SELECT v_membership, v_worker;
END;
$$;
REVOKE ALL ON FUNCTION public.app_establishment_create_worker(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_establishment_create_worker(uuid, text, text) TO app_runtime;

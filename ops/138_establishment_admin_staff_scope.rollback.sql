-- Rollback of 138 (C1/C2). Restores the policies exactly as they were after 137 and removes the
-- creation function. Run as the migrations superuser. Non-destructive: policies and one function only.
-- Revert the backend code of the same PR FIRST (it calls app_establishment_create_worker).
BEGIN;
DROP POLICY IF EXISTS organization_worker_memberships_staff_write ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_staff_write ON organization_worker_memberships
  FOR ALL
  USING (((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
          AND (app_is_org_manager_definer() OR app_is_any_establishment_admin())) OR app_is_superadmin())
  WITH CHECK (((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
               AND (app_is_org_manager_definer() OR app_is_any_establishment_admin())) OR app_is_superadmin());

DROP POLICY IF EXISTS establishment_worker_assignments_manager_insert ON establishment_worker_assignments;
CREATE POLICY establishment_worker_assignments_manager_insert ON establishment_worker_assignments
  FOR INSERT
  WITH CHECK (((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
               AND (app_is_org_manager() OR app_is_establishment_admin(location_id))) OR app_is_superadmin());

DROP POLICY IF EXISTS establishment_worker_assignments_manager_update ON establishment_worker_assignments;
CREATE POLICY establishment_worker_assignments_manager_update ON establishment_worker_assignments
  FOR UPDATE
  USING (((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
          AND (app_is_org_manager() OR app_is_establishment_admin(location_id))) OR app_is_superadmin())
  WITH CHECK (((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
               AND (app_is_org_manager() OR app_is_establishment_admin(location_id))) OR app_is_superadmin());

DROP POLICY IF EXISTS workers_self_or_manager_update ON workers;
DROP POLICY IF EXISTS workers_self_or_shared_org ON workers;
CREATE POLICY workers_self_or_shared_org ON workers
  FOR ALL
  USING ((user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
         OR ((EXISTS (SELECT 1 FROM organization_worker_memberships owm
                       WHERE owm.worker_id = workers.id
                         AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                         AND owm.status = 'active'::worker_membership_status_enum))
             AND app_has_active_membership())
         OR app_is_superadmin());

DROP FUNCTION IF EXISTS public.app_establishment_create_worker(uuid, text, text);
DELETE FROM schema_migrations WHERE filename = '138_establishment_admin_staff_scope.sql';
COMMIT;

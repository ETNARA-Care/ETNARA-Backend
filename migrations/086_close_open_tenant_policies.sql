-- Phase 12.4a: close the open "tenant_isolation" policies.
--
-- Twelve tables had a PERMISSIVE FOR ALL "<table>_tenant_isolation" policy
-- that granted every active member of an organization (a family member, a
-- caregiver) full read AND write access to every row of that organization,
-- with no WITH CHECK. Because permissive policies are OR'ed, it overrode the
-- narrower role policies next to it. Verified on PostgreSQL: a family member
-- could read every caregiver's check-ins (with location), delete them, and
-- accept shifts on caregivers' behalf. No endpoint exposed this.
--
-- This migration:
--   1. turns each tenant_isolation policy into a RESTRICTIVE gate (same
--      organization + active membership, or the platform), keeping the
--      self-lookup paths (/me reads its own memberships and roles across
--      organizations; legacy family invitation token lookup);
--   2. leaves reads as they were on the structural tables (members of the
--      organization keep reading them -- many flows depend on it) but takes
--      away the org-wide read on verification_events and assignments, which
--      already have manager / own-worker / family policies;
--   3. grants writes only to the roles that legitimately write each table.
-- RESTRICTIVE policies from 078 (platform_phi_deny) and 085 still apply.

-- Helpers ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_is_any_establishment_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.establishment_admin_assignments eaa
        JOIN public.organization_memberships om ON om.id = eaa.organization_membership_id AND om.organization_id = eaa.organization_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND eaa.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND om.status = 'active'
          AND eaa.archived_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.app_is_own_worker_membership(p_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_worker_memberships owm
        JOIN public.workers w ON w.id = owm.worker_id
        WHERE owm.id = p_membership_id
          AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );
$$;

-- A caregiver now sees only its own check-ins. Check-out still needs to know
-- whether anyone else is still on the shift before marking it completed.
CREATE OR REPLACE FUNCTION public.app_shift_has_open_check_in(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT app_has_active_membership() AND EXISTS (
        SELECT 1 FROM public.verification_events ve1
        WHERE ve1.shift_id = p_shift_id
          AND ve1.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND ve1.event_type = 'check_in'
          AND NOT EXISTS (
              SELECT 1 FROM public.verification_events ve2
              WHERE ve2.shift_id = ve1.shift_id
                AND ve2.organization_worker_membership_id = ve1.organization_worker_membership_id
                AND ve2.event_type = 'check_out'
                AND ve2.occurred_at > ve1.occurred_at
          )
    );
$$;

REVOKE ALL ON FUNCTION public.app_is_any_establishment_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_shift_has_open_check_in(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_shift_has_open_check_in(uuid) TO app_runtime;
REVOKE ALL ON FUNCTION public.app_is_own_worker_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_any_establishment_admin() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_is_own_worker_membership(uuid) TO app_runtime;

-- Same organization + active membership (or the platform). Repeated per table
-- below because a policy cannot reference a shared expression.

-- 1. assignments: role policies already exist (manager, own worker). ------
DROP POLICY IF EXISTS assignments_tenant_isolation ON assignments;
CREATE POLICY assignments_tenant_isolation ON assignments AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
-- Reading who is assigned to a recipient is needed by family-side flows that
-- build a conversation's participants (messaging.resolveOrCreateFamilyConversation).
DROP POLICY IF EXISTS assignments_member_read ON assignments;
CREATE POLICY assignments_member_read ON assignments FOR SELECT
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership());

-- 2. verification_events: manager, own worker and family_read already exist.
DROP POLICY IF EXISTS verification_events_tenant_isolation ON verification_events;
CREATE POLICY verification_events_tenant_isolation ON verification_events AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

-- 3. verification_overrides: read + manager write policies already exist.
DROP POLICY IF EXISTS verification_overrides_tenant_isolation ON verification_overrides;
CREATE POLICY verification_overrides_tenant_isolation ON verification_overrides AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

-- 4. organization_memberships: own rows readable everywhere (/me); writes
--    still limited by 085 (administrators or the platform).
DROP POLICY IF EXISTS organization_memberships_tenant_isolation ON organization_memberships;
CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
           OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
           OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS organization_memberships_member_read ON organization_memberships;
CREATE POLICY organization_memberships_member_read ON organization_memberships FOR SELECT
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS organization_memberships_staff_write ON organization_memberships;
CREATE POLICY organization_memberships_staff_write ON organization_memberships FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_admin()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_admin()) OR app_is_superadmin());

-- 5. user_roles: same shape; 085 RESTRICTIVE authority still decides which
--    roles may be granted (a supervisor may grant WORKER / FAMILY).
DROP POLICY IF EXISTS user_roles_tenant_isolation ON user_roles;
CREATE POLICY user_roles_tenant_isolation ON user_roles AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
           OR EXISTS (SELECT 1 FROM organization_memberships om WHERE om.id = user_roles.organization_membership_id AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
           OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS user_roles_member_read ON user_roles;
CREATE POLICY user_roles_member_read ON user_roles FOR SELECT
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS user_roles_staff_write ON user_roles;
CREATE POLICY user_roles_staff_write ON user_roles FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin());

-- 6. organization_worker_memberships: managers and establishment admins write.
DROP POLICY IF EXISTS organization_worker_memberships_tenant_isolation ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_tenant_isolation ON organization_worker_memberships AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS organization_worker_memberships_member_read ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_member_read ON organization_worker_memberships FOR SELECT
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS organization_worker_memberships_staff_write ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_staff_write ON organization_worker_memberships FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND (app_is_org_manager_definer() OR app_is_any_establishment_admin())) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND (app_is_org_manager_definer() OR app_is_any_establishment_admin())) OR app_is_superadmin());

-- 7. worker_eligibility: a cached result the server recomputes on every check;
--    managers, establishment admins and the worker's own session write it.
DROP POLICY IF EXISTS worker_eligibility_tenant_isolation ON worker_eligibility;
CREATE POLICY worker_eligibility_tenant_isolation ON worker_eligibility AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS worker_eligibility_member_read ON worker_eligibility;
CREATE POLICY worker_eligibility_member_read ON worker_eligibility FOR SELECT
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS worker_eligibility_write ON worker_eligibility;
CREATE POLICY worker_eligibility_write ON worker_eligibility FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND (app_is_org_manager_definer() OR app_is_any_establishment_admin() OR app_is_own_worker_membership(organization_worker_membership_id)))
           OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND (app_is_org_manager_definer() OR app_is_any_establishment_admin() OR app_is_own_worker_membership(organization_worker_membership_id)))
           OR app_is_superadmin());

-- 8. Tables with no application writer as app_runtime: managers only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assignment_history', 'professional_scope', 'worker_roles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$s_tenant_isolation ON %1$s', t);
    EXECUTE format($p$CREATE POLICY %1$s_tenant_isolation ON %1$s AS RESTRICTIVE FOR ALL
      USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
      WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_member_read ON %1$s', t);
    EXECUTE format($p$CREATE POLICY %1$s_member_read ON %1$s FOR SELECT
      USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_manager_write ON %1$s', t);
    EXECUTE format($p$CREATE POLICY %1$s_manager_write ON %1$s FOR ALL
      USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin())
      WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin())$p$, t);
  END LOOP;
END $$;

-- 9. consent_records and family_invitations had an org-only check (no
--    membership requirement). Keep the legacy token lookup working.
DROP POLICY IF EXISTS consent_records_tenant_isolation ON consent_records;
CREATE POLICY consent_records_tenant_isolation ON consent_records AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS consent_records_member_read ON consent_records;
CREATE POLICY consent_records_member_read ON consent_records FOR SELECT
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS consent_records_manager_write ON consent_records;
CREATE POLICY consent_records_manager_write ON consent_records FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin());

DROP POLICY IF EXISTS family_invitations_tenant_isolation ON family_invitations;
CREATE POLICY family_invitations_tenant_isolation ON family_invitations AS RESTRICTIVE FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
           OR invitation_token_hash = NULLIF(current_setting('app.lookup_token_hash', true), '')
           OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS family_invitations_manager_all ON family_invitations;
CREATE POLICY family_invitations_manager_all ON family_invitations FOR ALL
    USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin())
    WITH CHECK ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager_definer()) OR app_is_superadmin());

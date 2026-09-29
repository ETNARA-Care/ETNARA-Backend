-- Migration 069: bind tenant-scoped RLS to authenticated active membership.
-- A caller must not gain access merely by forging app.current_org_id.

-- Identity / workforce rows exposed by organization_id.
DROP POLICY IF EXISTS organization_memberships_tenant_isolation ON organization_memberships;
CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS user_roles_tenant_isolation ON user_roles;
CREATE POLICY user_roles_tenant_isolation ON user_roles
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS organization_worker_memberships_tenant_isolation ON organization_worker_memberships;
CREATE POLICY organization_worker_memberships_tenant_isolation ON organization_worker_memberships
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS worker_roles_tenant_isolation ON worker_roles;
CREATE POLICY worker_roles_tenant_isolation ON worker_roles
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS professional_scope_tenant_isolation ON professional_scope;
CREATE POLICY professional_scope_tenant_isolation ON professional_scope
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

-- Compliance/review rows.
DROP POLICY IF EXISTS organization_credential_reviews_tenant_isolation ON organization_credential_reviews;
CREATE POLICY organization_credential_reviews_tenant_isolation ON organization_credential_reviews
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS worker_eligibility_tenant_isolation ON worker_eligibility;
CREATE POLICY worker_eligibility_tenant_isolation ON worker_eligibility
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

-- Scheduling/assignment rows. shifts already checks app_has_active_membership().
DROP POLICY IF EXISTS assignments_tenant_isolation ON assignments;
CREATE POLICY assignments_tenant_isolation ON assignments
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS assignment_history_tenant_isolation ON assignment_history;
CREATE POLICY assignment_history_tenant_isolation ON assignment_history
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS verification_events_tenant_isolation ON verification_events;
CREATE POLICY verification_events_tenant_isolation ON verification_events
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

DROP POLICY IF EXISTS verification_overrides_tenant_isolation ON verification_overrides;
CREATE POLICY verification_overrides_tenant_isolation ON verification_overrides
  USING ((organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());

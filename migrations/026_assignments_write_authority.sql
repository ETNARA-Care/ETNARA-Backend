-- Migration 026: Assignments write authority
-- SECURITY ISSUE FOUND during this gate's audit: assignments_tenant_isolation
-- (from 014) only checks organization_id match, with no role requirement --
-- confirmed via direct execution that a plain WORKER-role member (active
-- membership, no ORGANIZATION_ADMIN/SUPERVISOR role) could INSERT
-- assignments directly. This is inconsistent with shifts, which already
-- requires app_is_org_manager() to create/modify (018). Scheduling who
-- works which shift is the same class of managerial operation as creating
-- the shift itself.

DROP POLICY IF EXISTS assignments_tenant_isolation ON assignments;

CREATE POLICY assignments_read ON assignments
    FOR SELECT
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());
-- Read visibility unchanged: any active tenant member (including plain
-- workers) can see the org's assignments -- consistent with shifts'
-- worker-facing read path being schedule-visibility-oriented.

CREATE POLICY assignments_write ON assignments
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()
        OR app_is_superadmin()
    );

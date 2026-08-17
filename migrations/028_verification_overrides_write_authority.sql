-- Migration 028: verification_overrides write authority
-- SECURITY ISSUE FOUND during this gate's audit, confirmed via direct
-- attack execution (not by inspection alone):
--
-- 1. verification_overrides_tenant_isolation (014) only checks
--    organization_id match -- ANY active org member, including one with no
--    manager role at all, could INSERT an override row claiming to
--    "authorize" a check-in/check-out exception.
-- 2. The policy never confirms that the referenced verification_event_id
--    actually belongs to the SAME organization_id being claimed on the
--    override row -- an Org A manager could insert an override with
--    organization_id='Org A' pointing at a verification_event_id that
--    actually belongs to Org B, since nothing cross-checks the two.
--
-- Both are closed the same way as every other write-authority gap found
-- in this project: split into a SELECT policy (unchanged visibility) and
-- a write policy requiring real org-manager authority AND that the
-- referenced event genuinely belongs to that same organization.

DROP POLICY IF EXISTS verification_overrides_tenant_isolation ON verification_overrides;

CREATE POLICY verification_overrides_read ON verification_overrides
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );

CREATE POLICY verification_overrides_write ON verification_overrides
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        AND EXISTS (
            SELECT 1 FROM verification_events ve
            WHERE ve.id = verification_overrides.verification_event_id
              AND ve.organization_id = verification_overrides.organization_id
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        AND EXISTS (
            SELECT 1 FROM verification_events ve
            WHERE ve.id = verification_overrides.verification_event_id
              AND ve.organization_id = verification_overrides.organization_id
        )
        OR app_is_superadmin()
    );

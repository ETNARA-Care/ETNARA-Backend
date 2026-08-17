-- Migration 029: organization_care_event_types write authority
-- SECURITY ISSUE FOUND during this gate's audit, confirmed via direct
-- attack execution: organization_care_event_types_tenant_isolation (014)
-- only checks organization_id match, with no role requirement -- a plain
-- active org member with NO manager role could enable/disable/relabel
-- care event types for the entire organization, affecting what every
-- caregiver is allowed to document. This is configuration authority that
-- belongs to org managers, matching the same principle already enforced
-- for shifts/assignments/verification_overrides/requirements.

DROP POLICY IF EXISTS organization_care_event_types_tenant_isolation ON organization_care_event_types;

CREATE POLICY organization_care_event_types_read ON organization_care_event_types
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );
-- Read visibility unchanged: any active tenant member needs to see which
-- types are enabled/labeled to use them correctly.

CREATE POLICY organization_care_event_types_write ON organization_care_event_types
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

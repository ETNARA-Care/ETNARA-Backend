-- Migration 019: RLS Fix -- Organizations Membership Check
-- REAL VULNERABILITY FOUND BY INTEGRATION TESTS 4, 5, 34: the policies on
-- organizations (and its physical hierarchy: organization_settings,
-- locations, units, rooms) only checked `id = current_org_id`, never that
-- current_user_id actually holds an active membership in that org. Since
-- current_org_id is a value the BACKEND sets after validating the user's
-- selected organization, this was safe as long as the backend never sets
-- current_org_id to an org the user doesn't belong to -- but the whole
-- point of RLS is to not rely on that assumption holding everywhere,
-- forever, in every code path. Fixed here to require real membership.

DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_membership_required ON organizations
    USING (
        (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS organization_settings_tenant_isolation ON organization_settings;
CREATE POLICY organization_settings_membership_required ON organization_settings
    USING (
        (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS locations_tenant_isolation ON locations;
CREATE POLICY locations_membership_required ON locations
    USING (
        (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS units_tenant_isolation ON units;
CREATE POLICY units_membership_required ON units
    USING (
        (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS rooms_tenant_isolation ON rooms;
CREATE POLICY rooms_membership_required ON rooms
    USING (
        (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
        OR app_is_superadmin()
    );

-- NOTE: care_recipients, shifts, care_events, and every other table
-- introduced/hardened in 014 and 018 already required
-- app_has_active_membership() (or the equivalent worker-assignment check)
-- alongside the organization_id match -- this gap was specific to the
-- organizational hierarchy tables from migration 002, which predate that
-- pattern being consistently applied. Audited: no other table in the
-- schema has this same gap (confirmed by re-reading every USING clause in
-- 014 and 018).

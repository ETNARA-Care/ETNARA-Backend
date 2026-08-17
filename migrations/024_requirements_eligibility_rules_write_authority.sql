-- Migration 024: requirements + eligibility_rules write-authority fix
-- SECURITY ISSUE FOUND during audit of this gate: both tables inherited the
-- exact same shape of gap already fixed in 022 for
-- credential_platform_verifications and requirement_sets, but were
-- themselves missed at the time. Confirmed via direct PostgreSQL execution:
-- an ordinary Organization Admin (normal tenant context, no platform
-- authority) could INSERT and UPDATE rows belonging to a GLOBAL
-- (organization_id IS NULL) requirement_set, because the existing ALL-
-- commands policies use "organization_id IS NULL OR mine" for BOTH read
-- visibility and write authority -- the NULL branch is unconditionally
-- true for every tenant, regardless of who is asking.

-- ---------------------------------------------------------------------
-- 1. requirements: SELECT stays broad (global set requirements are
--    legitimately visible to every tenant, own-org set requirements only
--    to that org -- unchanged). INSERT/UPDATE/DELETE now require either
--    platform authority (for a requirement inside a GLOBAL set) or that
--    the requirement's set actually belongs to the caller's own
--    organization (for a tenant-scoped set).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS requirements_via_requirement_set ON requirements;

CREATE POLICY requirements_read ON requirements
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND (rs.organization_id IS NULL OR rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        )
        OR app_is_superadmin()
    );

CREATE POLICY requirements_write ON requirements
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        OR app_is_superadmin()
    );

-- ---------------------------------------------------------------------
-- 2. eligibility_rules: identical fix, same reasoning.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS eligibility_rules_via_requirement_set ON eligibility_rules;

CREATE POLICY eligibility_rules_read ON eligibility_rules
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND (rs.organization_id IS NULL OR rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        )
        OR app_is_superadmin()
    );

CREATE POLICY eligibility_rules_write ON eligibility_rules
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        OR app_is_superadmin()
    );

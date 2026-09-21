-- Phase 7.6.2: organization compliance policies are editable only by a real
-- organization manager. Tenant isolation alone is insufficient because an
-- ordinary active member belongs to the same tenant but must remain read-only.

DROP POLICY IF EXISTS requirement_sets_write ON requirement_sets;
CREATE POLICY requirement_sets_write ON requirement_sets
    FOR ALL
    USING (
        (
            organization_id IS NOT NULL
            AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        (
            organization_id IS NOT NULL
            AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS requirements_write ON requirements;
CREATE POLICY requirements_write ON requirements
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND app_is_org_manager()
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

DROP POLICY IF EXISTS eligibility_rules_write ON eligibility_rules;
CREATE POLICY eligibility_rules_write ON eligibility_rules
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND app_is_org_manager()
        )
        OR app_is_superadmin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND rs.organization_id IS NOT NULL
              AND rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND app_is_org_manager()
        )
        OR app_is_superadmin()
    );

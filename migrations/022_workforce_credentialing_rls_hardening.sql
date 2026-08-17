-- Migration 022: Workforce + Credentialing RLS Hardening
-- Closes two write-authority gaps identified while building the service
-- layer for this gate. Both were previously documented in 014 as
-- "restricted at the application layer" -- now that the application layer
-- exists, RLS must actually enforce it too (last line of defense).

-- ---------------------------------------------------------------------
-- 1. credential_platform_verifications: SELECT stays broad (anyone who can
--    see the credential can see its platform verification status -- that's
--    the whole point of "verification travels with the worker"). INSERT/
--    UPDATE/DELETE now require real platform authority, not just visibility
--    of the credential.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS credential_platform_verifications_via_credential ON credential_platform_verifications;

CREATE POLICY credential_platform_verifications_read ON credential_platform_verifications
    FOR SELECT
    USING (
        EXISTS (SELECT 1 FROM credentials c WHERE c.id = credential_platform_verifications.credential_id)
        OR app_is_superadmin()
    );

CREATE POLICY credential_platform_verifications_write ON credential_platform_verifications
    FOR ALL
    USING (app_is_superadmin())
    WITH CHECK (app_is_superadmin());
-- FOR ALL here also covers SELECT, but that only ADDS visibility (OR'd with
-- the read policy above) -- it never subtracts from it. For INSERT/UPDATE/
-- DELETE, the read policy simply doesn't apply (it's SELECT-only), so this
-- write policy is the ONLY one in play, and it hard-requires
-- app_is_superadmin() -- which itself requires a real, unrevoked row in
-- platform_admins, not a client-controlled flag.

-- ---------------------------------------------------------------------
-- 2. requirement_sets: SELECT stays broad (global sets visible to all
--    tenants, org-specific sets visible to their own org). INSERT/UPDATE/
--    DELETE of a GLOBAL set (organization_id IS NULL) now requires platform
--    authority; a tenant may only write rows scoped to its own
--    organization_id.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS requirement_sets_global_or_own_org ON requirement_sets;

CREATE POLICY requirement_sets_read ON requirement_sets
    FOR SELECT
    USING (
        organization_id IS NULL
        OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );

CREATE POLICY requirement_sets_write ON requirement_sets
    FOR ALL
    USING (
        (organization_id IS NOT NULL AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        OR app_is_superadmin()
    )
    WITH CHECK (
        (organization_id IS NOT NULL AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        OR app_is_superadmin()
    );
-- A tenant can never write a row with organization_id NULL (the first
-- branch explicitly requires organization_id IS NOT NULL AND matching
-- their own org) -- only a verified platform admin can create/modify a
-- platform-wide global requirement set.

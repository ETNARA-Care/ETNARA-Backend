-- Phase 10.0: establishments reuse the existing locations hierarchy.
-- Read access remains tenant-scoped. Writes require organization-manager
-- authority and are deliberately limited to INSERT/UPDATE; records are
-- archived, never deleted, so operational and audit history is preserved.

DROP POLICY IF EXISTS locations_membership_required ON locations;

CREATE POLICY locations_member_read ON locations FOR SELECT
USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND app_has_active_membership())
  OR app_is_superadmin()
);

CREATE POLICY locations_manager_insert ON locations FOR INSERT
WITH CHECK (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND app_is_org_manager())
  OR app_is_superadmin()
);

CREATE POLICY locations_manager_update ON locations FOR UPDATE
USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND app_is_org_manager())
  OR app_is_superadmin()
)
WITH CHECK (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND app_is_org_manager())
  OR app_is_superadmin()
);

-- The runtime role received broad baseline grants in migration 017. Remove
-- DELETE explicitly: archival is the only application-supported lifecycle.
REVOKE DELETE ON locations FROM app_runtime;

-- First runtime access for SmartMatch: agency-owned opportunities only.
-- No cross-tenant NETWORK discovery and no application/patient access.
-- An authenticated active organization administrator can manage only its
-- own organization's opportunity metadata; other roles get no access.
CREATE POLICY smartmatch_opportunities_agency_admin
ON smartmatch_opportunities
FOR ALL TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id
    JOIN roles r ON r.id = ur.role_id
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = smartmatch_opportunities.organization_id
      AND om.status = 'active'
      AND r.code = 'ORGANIZATION_ADMIN'
  )
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id
    JOIN roles r ON r.id = ur.role_id
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = smartmatch_opportunities.organization_id
      AND om.status = 'active'
      AND r.code = 'ORGANIZATION_ADMIN'
  )
);

GRANT SELECT, INSERT, UPDATE ON smartmatch_opportunities TO app_runtime;
-- Deliberately no DELETE, no access to applications or location preferences.
-- Platform admin has no policy and cannot inspect this table.

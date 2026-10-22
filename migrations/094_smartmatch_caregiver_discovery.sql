-- Allow read-only discovery of published INTERNAL opportunities by active caregivers
-- belonging to the same tenant. Never expose other agencies or patient data.
CREATE POLICY smartmatch_opportunities_caregiver_discovery
ON smartmatch_opportunities
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND visibility = 'INTERNAL'
  AND status = 'PUBLISHED'
  AND starts_at > now()
  AND EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id
    JOIN roles r ON r.id = ur.role_id
    WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND om.organization_id = smartmatch_opportunities.organization_id
      AND om.status = 'active'
      AND r.code = 'CAREGIVER'
  )
);
-- SELECT already granted to app_runtime by migration 092.

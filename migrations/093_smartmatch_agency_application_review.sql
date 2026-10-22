-- SmartMatch internal applications: controlled, agency-scoped review.
-- Caregiver submission and network discovery remain disabled until a
-- separately reviewed consent, eligibility and credential workflow exists.
-- Never expose patient identifiers or care plans through these tables.
CREATE POLICY smartmatch_applications_agency_review
ON smartmatch_applications
FOR SELECT TO app_runtime
USING (
  EXISTS (
    SELECT 1 FROM smartmatch_opportunities so
    WHERE so.id = smartmatch_applications.opportunity_id
      AND so.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND so.visibility = 'INTERNAL'
      AND EXISTS (
        SELECT 1 FROM organization_memberships om
        JOIN user_roles ur ON ur.organization_membership_id = om.id
        JOIN roles r ON r.id = ur.role_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = so.organization_id
          AND om.status = 'active'
          AND r.code = 'ORGANIZATION_ADMIN'
      )
  )
);
-- SELECT only: no caregiver applications or approvals are enabled yet.
GRANT SELECT ON smartmatch_applications TO app_runtime;

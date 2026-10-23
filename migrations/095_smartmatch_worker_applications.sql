-- Migration 095: SmartMatch Gate 1 -- real caregiver role, network lock,
-- caregiver applications with recorded consent.
--
-- 1. Migration 094 required role code 'CAREGIVER', which does not exist
--    (roles are PLATFORM_SUPERADMIN, ORGANIZATION_ADMIN, SUPERVISOR, WORKER,
--    FAMILY). Caregiver discovery therefore always returned zero rows.
--    Caregiver access now requires the WORKER role AND an active
--    organization_worker_memberships row, matching organizationContext.
-- 2. Cross-agency (NETWORK) opportunities stay disabled at the database
--    level. The CHECK constraint applies to every writer, including direct
--    SQL by privileged roles. Enabling the network requires a new reviewed
--    migration that drops this constraint.
-- 3. Caregivers may create, read and withdraw only their own applications,
--    only for published internal opportunities of their current agency,
--    and only with an explicit consent timestamp and consent text version.
--    Policies are acyclic: application policies read no other SmartMatch
--    table; the opportunity discovery policy reads applications.
--    Approve/reject is NOT granted to app_runtime: it will go through a
--    single transactional SECURITY DEFINER function in Gate 2.
-- 4. Agency policies from 092/093 now use the SECURITY DEFINER authority
--    helper app_is_org_admin() (migration 085) instead of inline queries on
--    organization_memberships/user_roles, so they cannot depend on those
--    tables' own RLS (see recursion fixed in 079).
--
-- Helpers accept no caller-supplied user or organization: both come only
-- from the authenticated session context. Fixed search_path, no PUBLIC
-- execute. ETNARA platform/Tower context gets no SmartMatch policy at all.

-- 1. Helpers ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_smartmatch_is_active_worker()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        JOIN public.user_roles ur
          ON ur.organization_membership_id = om.id
         AND ur.organization_id = om.organization_id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND om.status = 'active'
          AND r.code = 'WORKER'
    )
    AND EXISTS (
        SELECT 1
        FROM public.workers w
        JOIN public.organization_worker_memberships owm ON owm.worker_id = w.id
        WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.status = 'active'
    );
$$;
REVOKE ALL ON FUNCTION public.app_smartmatch_is_active_worker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_smartmatch_is_active_worker() TO app_runtime;

-- 2. Network lock ----------------------------------------------------------
ALTER TABLE smartmatch_opportunities
  ADD CONSTRAINT smartmatch_network_disabled CHECK (visibility = 'INTERNAL');

-- 3. Tenant column, consent and withdrawal audit ---------------------------
-- organization_id is denormalized onto applications so that application
-- policies never read smartmatch_opportunities under RLS (FORCE RLS means a
-- SECURITY DEFINER owner would not bypass it either). The composite foreign
-- key guarantees it always equals the opportunity's organization; RI checks
-- run without RLS.
ALTER TABLE smartmatch_opportunities
  ADD CONSTRAINT smartmatch_opportunities_id_org_key UNIQUE (id, organization_id);
ALTER TABLE smartmatch_applications
  ADD COLUMN IF NOT EXISTS organization_id uuid;
UPDATE smartmatch_applications a
   SET organization_id = o.organization_id
  FROM smartmatch_opportunities o
 WHERE o.id = a.opportunity_id AND a.organization_id IS NULL;
ALTER TABLE smartmatch_applications
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT smartmatch_applications_opportunity_org_fkey
    FOREIGN KEY (opportunity_id, organization_id)
    REFERENCES smartmatch_opportunities (id, organization_id);
CREATE INDEX IF NOT EXISTS idx_smartmatch_applications_org_opportunity
  ON smartmatch_applications (organization_id, opportunity_id, status);

ALTER TABLE smartmatch_applications
  ADD COLUMN IF NOT EXISTS consented_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_version varchar(40),
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;

-- NOT VALID: enforced for every new or updated row; does not fail on any
-- pre-existing synthetic row in an isolated environment.
ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_application_consent_required
  CHECK (consented_at IS NOT NULL AND consent_version IS NOT NULL) NOT VALID;
ALTER TABLE smartmatch_applications
  ADD CONSTRAINT smartmatch_application_withdrawal_consistency
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)) NOT VALID;

-- 4. Agency policies on the authority helper ------------------------------
DROP POLICY IF EXISTS smartmatch_opportunities_agency_admin ON smartmatch_opportunities;
CREATE POLICY smartmatch_opportunities_agency_admin
ON smartmatch_opportunities
FOR ALL TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_is_org_admin()
);

DROP POLICY IF EXISTS smartmatch_applications_agency_review ON smartmatch_applications;
CREATE POLICY smartmatch_applications_agency_review
ON smartmatch_applications
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_admin()
);

-- 5. Caregiver discovery: WORKER, not CAREGIVER ----------------------------
DROP POLICY IF EXISTS smartmatch_opportunities_caregiver_discovery ON smartmatch_opportunities;
CREATE POLICY smartmatch_opportunities_caregiver_discovery
ON smartmatch_opportunities
FOR SELECT TO app_runtime
USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
  AND (
    (visibility = 'INTERNAL' AND status = 'PUBLISHED' AND starts_at > now())
    OR EXISTS (
      SELECT 1 FROM smartmatch_applications a
      WHERE a.opportunity_id = smartmatch_opportunities.id
        AND a.organization_id = smartmatch_opportunities.organization_id
        AND a.caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
);

-- 6. Caregiver applications -----------------------------------------------
CREATE POLICY smartmatch_applications_worker_own_read
ON smartmatch_applications
FOR SELECT TO app_runtime
USING (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
);

CREATE POLICY smartmatch_applications_worker_submit
ON smartmatch_applications
FOR INSERT TO app_runtime
WITH CHECK (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'PENDING'
  AND decided_by_user_id IS NULL
  AND decided_at IS NULL
  AND withdrawn_at IS NULL
  AND consented_at IS NOT NULL
  AND consent_version IS NOT NULL
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
  AND EXISTS (
    SELECT 1 FROM smartmatch_opportunities so
    WHERE so.id = smartmatch_applications.opportunity_id
      AND so.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND so.visibility = 'INTERNAL'
      AND so.status = 'PUBLISHED'
      AND so.starts_at > now()
  )
);

CREATE POLICY smartmatch_applications_worker_withdraw
ON smartmatch_applications
FOR UPDATE TO app_runtime
USING (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'PENDING'
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_smartmatch_is_active_worker()
)
WITH CHECK (
  caregiver_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND status = 'WITHDRAWN'
  AND withdrawn_at IS NOT NULL
  AND decided_by_user_id IS NULL
  AND decided_at IS NULL
);

-- Column-level grants: a caregiver can only set these columns. No DELETE.
-- The application id, status default, created_at come from defaults.
GRANT INSERT (opportunity_id, organization_id, caregiver_user_id, consented_at, consent_version)
  ON smartmatch_applications TO app_runtime;
GRANT UPDATE (status, withdrawn_at) ON smartmatch_applications TO app_runtime;

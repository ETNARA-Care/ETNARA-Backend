-- Migration 018: RLS Hardening
-- Fixes three real gaps from the previous security report:
--   1. app_is_superadmin() trusted a session flag alone -- now requires a
--      verified row in platform_admins.
--   2. Worker policies granted tenant-wide visibility on shifts,
--      care_recipients, care_events, verification_events, observations,
--      and incidents -- now require an actual assignment.
--   3. document_versions relied on implicit RLS propagation through a
--      subquery -- now explicit and self-contained.

-- =====================================================================
-- 1. HARDEN app_is_superadmin()
-- =====================================================================
CREATE OR REPLACE FUNCTION app_is_superadmin()
RETURNS boolean AS $$
    SELECT coalesce(current_setting('app.is_superadmin', true), 'false') = 'true'
       AND EXISTS (
            SELECT 1 FROM platform_admins pa
            WHERE pa.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND pa.revoked_at IS NULL
       );
$$ LANGUAGE sql STABLE;
-- Setting app.is_superadmin = 'true' from a compromised or malicious query
-- now accomplishes NOTHING by itself: the function also requires
-- current_user_id to have an unrevoked row in platform_admins, a real
-- table checked on every evaluation. A forged flag with no matching row
-- returns false. See Section 16 discussion in the report for the honest
-- limits of this mitigation.

-- =====================================================================
-- 2. HELPER FUNCTIONS FOR WORKER ASSIGNMENT-LEVEL ACCESS
-- =====================================================================
CREATE OR REPLACE FUNCTION app_current_worker_ids()
RETURNS TABLE(worker_id uuid) AS $$
    SELECT id FROM workers
    WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_org_manager()
RETURNS boolean AS $$
    -- True only for ORGANIZATION_ADMIN or SUPERVISOR in the current org.
    -- Used to grant broad tenant-wide read access; plain WORKER membership
    -- alone must NOT satisfy this.
    SELECT EXISTS (
        SELECT 1
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        JOIN organization_memberships om ON ur.organization_membership_id = om.id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND om.status = 'active'
          AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_worker_has_shift_assignment(p_shift_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm
          ON a.organization_worker_membership_id = owm.id
        WHERE a.shift_id = p_shift_id
          AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
    );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm
          ON a.organization_worker_membership_id = owm.id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND (
                a.care_recipient_id = p_care_recipient_id
                OR EXISTS (
                    SELECT 1 FROM shifts s
                    WHERE s.id = a.shift_id
                      AND s.care_recipient_id = p_care_recipient_id
                )
          )
    );
$$ LANGUAGE sql STABLE;

-- =====================================================================
-- 3. SHIFTS: split tenant-wide (admin/supervisor) from assignment-scoped (worker)
-- =====================================================================
DROP POLICY IF EXISTS shifts_tenant_staff ON shifts;

CREATE POLICY shifts_admin_supervisor_full_tenant ON shifts
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY shifts_worker_assigned_only ON shifts
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_shift_assignment(shifts.id)
    );
-- A Worker with no assignments row for this shift now gets zero rows --
-- previously, tenant membership alone was sufficient.

-- =====================================================================
-- 4. CARE_RECIPIENTS: same split, worker side goes through assignments
-- =====================================================================
DROP POLICY IF EXISTS care_recipients_tenant_staff ON care_recipients;

CREATE POLICY care_recipients_admin_supervisor_full_tenant ON care_recipients
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY care_recipients_worker_assigned_only ON care_recipients
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_recipient_assignment(care_recipients.id)
    );
-- care_recipients_family_specific (from 014) is untouched -- family access
-- logic does not change here.

-- =====================================================================
-- 5. CARE_EVENTS: split SELECT policies; INSERT enforced the same way
--    (RLS default USING clause governs both SELECT and the row being
--    written for INSERT/UPDATE/DELETE unless WITH CHECK differs -- here
--    they should match, so PostgreSQL structurally rejects a Worker
--    inserting a care event for an unassigned recipient/shift.)
-- =====================================================================
DROP POLICY IF EXISTS care_events_tenant_staff ON care_events;

CREATE POLICY care_events_admin_supervisor_full_tenant ON care_events
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY care_events_worker_assigned_only ON care_events
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_shift_assignment(care_events.shift_id)
        AND app_worker_has_recipient_assignment(care_events.care_recipient_id)
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_shift_assignment(care_events.shift_id)
        AND app_worker_has_recipient_assignment(care_events.care_recipient_id)
    );
-- WITH CHECK is what PostgreSQL evaluates on INSERT/UPDATE: a Worker cannot
-- insert a care_event whose shift_id/care_recipient_id fall outside their
-- own assignment, structurally, not just by application validation.
-- care_events_family_specific (SELECT-only, from 014) is untouched.

-- =====================================================================
-- 6. VERIFICATION_EVENTS: worker restricted to own membership + assigned shift
-- =====================================================================
DROP POLICY IF EXISTS verification_events_tenant_isolation ON verification_events;

CREATE POLICY verification_events_admin_supervisor_full_tenant ON verification_events
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY verification_events_worker_own_assignment ON verification_events
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND organization_worker_membership_id IN (
            SELECT owm.id FROM organization_worker_memberships owm
            WHERE owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
              AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        AND app_worker_has_shift_assignment(verification_events.shift_id)
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND organization_worker_membership_id IN (
            SELECT owm.id FROM organization_worker_memberships owm
            WHERE owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
              AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        )
        AND app_worker_has_shift_assignment(verification_events.shift_id)
    );

-- =====================================================================
-- 7. OBSERVATIONS: separate but identical-logic policies for select vs write
--    (kept as one FOR ALL policy per role tier, since the authorization
--    logic is the same for both in this MVP -- a worker who can observe a
--    recipient can also create observations about them).
-- =====================================================================
DROP POLICY IF EXISTS observations_tenant_isolation ON observations;

CREATE POLICY observations_admin_supervisor_full_tenant ON observations
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY observations_worker_assigned_only ON observations
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_recipient_assignment(observations.care_recipient_id)
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_recipient_assignment(observations.care_recipient_id)
    );

-- =====================================================================
-- 8. INCIDENTS: same pattern. Workers can create/see incidents for
--    recipients they are assigned to; admins/supervisors see all of the
--    tenant's incidents (they need the broader view for escalation).
-- =====================================================================
DROP POLICY IF EXISTS incidents_tenant_isolation ON incidents;

CREATE POLICY incidents_admin_supervisor_full_tenant ON incidents
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
        OR app_is_superadmin()
    );

CREATE POLICY incidents_worker_assigned_only ON incidents
    FOR ALL
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_recipient_assignment(incidents.care_recipient_id)
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_worker_has_recipient_assignment(incidents.care_recipient_id)
    );

-- =====================================================================
-- 9. DOCUMENT_VERSIONS: explicit, self-contained policy (no longer
--    implicitly relying on documents' own RLS being re-applied inside a
--    bare subquery).
-- =====================================================================
DROP POLICY IF EXISTS document_versions_via_document ON document_versions;

CREATE POLICY document_versions_explicit_access ON document_versions
    USING (
        EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = document_versions.document_id
              AND (
                    d.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
                    OR EXISTS (
                        SELECT 1 FROM organization_worker_memberships owm
                        WHERE owm.worker_id = d.worker_id
                          AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                          AND owm.status = 'active'
                    )
              )
        )
        OR app_is_superadmin()
    );
-- Organization A can see a version only while the worker holds an ACTIVE
-- membership in Organization A -- ending that membership removes access on
-- the next check, without depending on any other table's policy being
-- evaluated implicitly.

-- =====================================================================
-- 10. STORED_FILES: reviewed, confirmed correct, no change needed to the
--     ORGANIZATION_OPERATIONAL policy (strict organization_id match, as
--     required). The PLATFORM_PROFESSIONAL policy from 014 already covers
--     owner-worker and active-membership-org access; platform verification
--     staff access is intentionally folded into app_is_superadmin() for
--     the MVP (a dedicated non-superadmin "platform verifier" role is a
--     Phase 2 refinement, not required now -- flagging as a known
--     simplification rather than silently expanding scope).

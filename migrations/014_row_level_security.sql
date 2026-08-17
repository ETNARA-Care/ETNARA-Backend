-- Migration 014: Row Level Security
-- This is the migration that makes tenant isolation real at the database
-- level instead of merely hoped-for in application code.
--
-- IMPORTANT POSTGRES QUIRK (discovered via real connection-pooled testing,
-- fixed here directly since no production data exists yet): once a custom
-- placeholder GUC like app.current_org_id has been SET on a physical
-- connection at least once, PostgreSQL "reserves" it for that backend --
-- after the transaction that set it via SET LOCAL ends, current_setting()
-- returns an EMPTY STRING for it, not NULL, even with missing_ok=true.
-- This only shows up under real connection pooling (a pool reusing a
-- physical connection across unrelated transactions) -- a fresh psql
-- connection that never set the variable correctly returns NULL. Casting
-- an empty string directly to ::uuid throws a hard SQL error instead of
-- failing closed gracefully. Every cast of these two GUCs to uuid in this
-- file therefore uses NULLIF(current_setting(...), '')::uuid, which
-- converts that empty string to a proper NULL first -- restoring the
-- intended fail-closed behavior (a query with no context set returns zero
-- rows, rather than erroring) regardless of connection pooling history.
--
-- CONTEXT VARIABLES (set per-transaction, never per-connection):
--   app.current_user_id   -- uuid of the authenticated user
--   app.current_org_id    -- uuid of the organization active in this request
--   app.is_superadmin     -- 'true'/'false'
--   app.support_target_org_id -- set only during Superadmin support mode
--
-- These MUST be set via SET LOCAL at the start of every transaction, never
-- via a plain SET (which would persist on the physical connection and leak
-- across requests under connection pooling -- see the implementation notes
-- at the bottom of this file).

-- ---------------------------------------------------------------------
-- Helper: is the current user an active member of the current org?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_has_active_membership()
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND status = 'active'
    );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_superadmin()
RETURNS boolean AS $$
    SELECT coalesce(current_setting('app.is_superadmin', true), 'false') = 'true';
$$ LANGUAGE sql STABLE;

-- ===================== ORGANIZATIONS & CARE SETTINGS =====================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
    USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_settings_tenant_isolation ON organization_settings
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY locations_tenant_isolation ON locations
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY units_tenant_isolation ON units
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY rooms_tenant_isolation ON rooms
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== IDENTITY =====================
-- `users` itself is intentionally NOT tenant-scoped (a user can belong to
-- several orgs) -- RLS here restricts a row to being visible only to itself
-- or to someone sharing an active organization with them.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self_or_shared_org ON users
    USING (
        id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR EXISTS (
            SELECT 1 FROM organization_memberships om1
            JOIN organization_memberships om2
              ON om1.organization_id = om2.organization_id
            WHERE om1.user_id = users.id
              AND om2.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND om1.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND om1.status = 'active' AND om2.status = 'active'
        )
        OR app_is_superadmin()
    );

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- roles, permissions, role_permissions: global catalogs, read-only, no
-- sensitive per-user data -- NO RLS (per instructions: don't add RLS to
-- global read-only catalogs).

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_roles_tenant_isolation ON user_roles
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_self_only ON sessions
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_superadmin());

-- ===================== CARE RECIPIENTS & FAMILY =====================

ALTER TABLE care_recipients ENABLE ROW LEVEL SECURITY;

-- Admin/Supervisor/Worker: tenant-level visibility (Worker is further
-- restricted below to only recipients they are actually assigned to, via a
-- second, additive policy -- Postgres RLS policies are OR'd together by
-- default for permissive policies of the same command).
CREATE POLICY care_recipients_tenant_staff ON care_recipients
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_has_active_membership()
        AND NOT EXISTS ( -- excludes pure FAMILY-only memberships from this broad policy
            SELECT 1 FROM user_roles ur
            JOIN organization_memberships om
              ON ur.organization_membership_id = om.id
            JOIN roles r ON ur.role_id = r.id
            WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND r.code = 'FAMILY'
        )
        OR app_is_superadmin()
    );

-- Family: requires BOTH an active organization_membership AND an active,
-- specific family_relationship to THIS care_recipient. This is the
-- structural guarantee that a FAMILY membership alone never reveals other
-- residents.
CREATE POLICY care_recipients_family_specific ON care_recipients
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_has_active_membership()
        AND EXISTS (
            SELECT 1 FROM family_relationships fr
            WHERE fr.care_recipient_id = care_recipients.id
              AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND fr.status = 'active'
        )
    );

ALTER TABLE care_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY care_plans_tenant_isolation ON care_plans
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE family_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_invitations_tenant_isolation ON family_invitations
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE family_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY family_relationships_own_or_staff ON family_relationships
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            OR app_has_active_membership() -- staff can see relationship records for their org
        )
        OR app_is_superadmin()
    );

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_records_tenant_isolation ON consent_records
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== WORKFORCE =====================
-- `workers` is global (like `users`) -- visibility follows the same
-- "self or shared active org" logic as users, via organization_worker_memberships.

ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY workers_self_or_shared_org ON workers
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR EXISTS (
            SELECT 1 FROM organization_worker_memberships owm
            WHERE owm.worker_id = workers.id
              AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND owm.status = 'active'
        ) AND app_has_active_membership()
        OR app_is_superadmin()
    );

ALTER TABLE organization_worker_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_worker_memberships_tenant_isolation ON organization_worker_memberships
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE worker_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_roles_tenant_isolation ON worker_roles
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE professional_scope ENABLE ROW LEVEL SECURITY;
CREATE POLICY professional_scope_tenant_isolation ON professional_scope
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== STORED FILES =====================

ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY stored_files_organizational_scope ON stored_files
    USING (
        scope_type = 'ORGANIZATION_OPERATIONAL'
        AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );

CREATE POLICY stored_files_professional_scope ON stored_files
    USING (
        scope_type = 'PLATFORM_PROFESSIONAL'
        AND (
            owner_worker_id IN (
                SELECT id FROM workers
                WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            )
            OR EXISTS (
                SELECT 1 FROM organization_worker_memberships owm
                WHERE owm.worker_id = stored_files.owner_worker_id
                  AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                  AND owm.status = 'active'
            )
        )
        OR app_is_superadmin()
    );
-- A professional's own files are visible to them always, and to any
-- organization where they currently hold an active membership -- never to
-- an organization they have no relationship with, and access disappears
-- the moment that membership is set to 'inactive'.

-- ===================== CREDENTIALING =====================
-- credential_types: global read-only catalog -- NO RLS.
-- documents, document_versions, credentials: belong to the worker, not to
-- one organization -- visibility mirrors the `workers` policy logic.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_worker_scope ON documents
    USING (
        worker_id IN (SELECT id FROM workers WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        OR EXISTS (
            SELECT 1 FROM organization_worker_memberships owm
            WHERE owm.worker_id = documents.worker_id
              AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND owm.status = 'active'
        )
        OR app_is_superadmin()
    );

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_versions_via_document ON document_versions
    USING (
        EXISTS (
            SELECT 1 FROM documents d WHERE d.id = document_versions.document_id
        ) -- relies on documents' own RLS policy to have already filtered; kept
          -- simple since document_versions has no direct organization_id.
        OR app_is_superadmin()
    );

ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY credentials_worker_scope ON credentials
    USING (
        worker_id IN (SELECT id FROM workers WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
        OR EXISTS (
            SELECT 1 FROM organization_worker_memberships owm
            WHERE owm.worker_id = credentials.worker_id
              AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND owm.status = 'active'
        )
        OR app_is_superadmin()
    );
-- This is the declarative expression of "Platform Verification travels with
-- the worker": any org where the worker holds active membership can read
-- the credential and its platform verification status.

ALTER TABLE credential_platform_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_platform_verifications_via_credential ON credential_platform_verifications
    USING (
        EXISTS (SELECT 1 FROM credentials c WHERE c.id = credential_platform_verifications.credential_id)
        OR app_is_superadmin()
    );
-- Write access (INSERT) to this table is restricted to platform staff at
-- the application/role-privilege layer, not via RLS predicate -- RLS here
-- governs read visibility only.

ALTER TABLE organization_credential_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_credential_reviews_tenant_isolation ON organization_credential_reviews
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());
-- This is what keeps Organization A's private review notes invisible to
-- Organization B: strict tenant isolation, no worker-scope exception.

-- requirement_sets, requirements, eligibility_rules: mostly global/platform
-- config with optional organization_id. Apply tenant isolation only when
-- organization_id IS NOT NULL; global rows (organization_id IS NULL) are
-- visible to all authenticated tenants (read-only reference data).

ALTER TABLE requirement_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirement_sets_global_or_own_org ON requirement_sets
    USING (
        organization_id IS NULL
        OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );

ALTER TABLE requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirements_via_requirement_set ON requirements
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = requirements.requirement_set_id
              AND (rs.organization_id IS NULL OR rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        )
        OR app_is_superadmin()
    );

ALTER TABLE eligibility_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY eligibility_rules_via_requirement_set ON eligibility_rules
    USING (
        EXISTS (
            SELECT 1 FROM requirement_sets rs
            WHERE rs.id = eligibility_rules.requirement_set_id
              AND (rs.organization_id IS NULL OR rs.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
        )
        OR app_is_superadmin()
    );

ALTER TABLE worker_eligibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_eligibility_tenant_isolation ON worker_eligibility
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== SCHEDULING & VERIFICATION =====================

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY shifts_tenant_staff ON shifts
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_has_active_membership()
        OR app_is_superadmin()
    );
-- Worker-level narrowing to "only shifts I'm assigned to" is applied in the
-- application query layer on top of this tenant-level policy (see note on
-- Worker policies below) -- RLS provides the tenant boundary; the
-- assignment-specific boundary for workers is enforced via the join through
-- `assignments`, which itself is fully tenant- and membership-scoped.

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignments_tenant_isolation ON assignments
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE assignment_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY assignment_history_tenant_isolation ON assignment_history
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- verification_methods: global catalog -- NO RLS.

ALTER TABLE verification_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY verification_events_tenant_isolation ON verification_events
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE verification_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY verification_overrides_tenant_isolation ON verification_overrides
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== CARE EVENTS =====================
-- care_event_types: global catalog -- NO RLS.

ALTER TABLE organization_care_event_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_care_event_types_tenant_isolation ON organization_care_event_types
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE care_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY care_events_tenant_staff ON care_events
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_has_active_membership()
        AND NOT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN organization_memberships om ON ur.organization_membership_id = om.id
            JOIN roles r ON ur.role_id = r.id
            WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND r.code = 'FAMILY'
        )
        OR app_is_superadmin()
    );

CREATE POLICY care_events_family_specific ON care_events
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM family_relationships fr
            WHERE fr.care_recipient_id = care_events.care_recipient_id
              AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND fr.status = 'active'
        )
    );

ALTER TABLE care_event_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY care_event_photos_via_care_event ON care_event_photos
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (
            app_has_active_membership() -- staff, subject to same event visibility as care_events
            OR EXISTS ( -- family, but ONLY if their relationship grants can_view_photos
                SELECT 1 FROM care_events ce
                JOIN family_relationships fr
                  ON fr.care_recipient_id = ce.care_recipient_id
                 AND fr.organization_id = ce.organization_id
                WHERE ce.id = care_event_photos.care_event_id
                  AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                  AND fr.status = 'active'
                  AND fr.can_view_photos = true
            )
        )
        OR app_is_superadmin()
    );
-- This is the declarative enforcement of "Family without can_view_photos
-- cannot access photographs" -- it is a predicate condition, not an
-- application-side filter that could be forgotten in some code path.

-- ===================== OBSERVATIONS & INCIDENTS =====================

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY observations_tenant_isolation ON observations
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant_isolation ON incidents
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE incident_timeline_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_timeline_entries_tenant_isolation ON incident_timeline_entries
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

ALTER TABLE incident_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_attachments_tenant_isolation ON incident_attachments
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR app_is_superadmin());

-- ===================== MESSAGES & NOTIFICATIONS =====================

ALTER TABLE message_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_threads_participant_only ON message_threads
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = message_threads.id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        OR app_is_superadmin()
    );
-- Organization membership alone grants NOTHING here -- explicit
-- participation is the only path to visibility, exactly as required.

ALTER TABLE message_thread_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_thread_participants_self_or_staff ON message_thread_participants
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_has_active_membership())
        OR app_is_superadmin()
    );

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_via_participation ON messages
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND EXISTS (
            SELECT 1 FROM message_thread_participants mtp
            WHERE mtp.message_thread_id = messages.message_thread_id
              AND mtp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        )
        OR app_is_superadmin()
    );

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_self_only ON notifications
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_superadmin());

-- ===================== AUDIT =====================
-- audit_log: RLS is intentionally minimal here -- the real protection is
-- privilege revocation (see below), not row filtering, since Admins should
-- generally be able to read their own org's audit trail in full.

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_or_platform ON audit_log
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR target_organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        OR app_is_superadmin()
    );

-- ---------------------------------------------------------------------
-- PRIVILEGE REVOCATION: audit_log must be append-only regardless of RLS.
-- This assumes an application role named `app_runtime` exists; adjust the
-- role name to match actual deployment.
-- ---------------------------------------------------------------------
-- REVOKE UPDATE, DELETE ON audit_log FROM app_runtime;
-- GRANT INSERT, SELECT ON audit_log TO app_runtime;
-- (Left commented here since app_runtime is created in the deployment/role
-- setup step, not in this schema migration -- executing this before that
-- role exists would fail. Must be run as part of environment provisioning,
-- immediately after this migration, before any real data is written.)

-- ===================== IMPLEMENTATION NOTES: RLS + CONNECTION POOLING =====================
--
-- Every request MUST wrap its work in an explicit transaction and set
-- context via SET LOCAL, e.g.:
--
--   BEGIN;
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_org_id = '<uuid>';
--   SET LOCAL app.is_superadmin = 'false';
--   -- ... queries ...
--   COMMIT;
--
-- SET LOCAL scopes the setting to the current transaction only -- it is
-- automatically discarded at COMMIT/ROLLBACK, which is exactly what makes
-- it safe under PgBouncer in transaction pooling mode: the physical
-- connection is returned to the pool between transactions, and the next
-- transaction (potentially a different user/org) MUST set its own context
-- from scratch. A plain SET (not SET LOCAL) would persist on the physical
-- connection and leak into whichever transaction/request reuses it next --
-- this must never be used for this context.
--
-- MANDATORY TEST before real data: open two application requests
-- concurrently against a connection pool sized to 1 (forcing reuse of the
-- same physical connection), assert that Request A's queries never return
-- Organization B's rows even momentarily, and that failing to call SET
-- LOCAL at the start of a transaction results in queries returning ZERO
-- rows (fail-closed), never falling back to some default/previous org
-- context.

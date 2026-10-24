-- ETNARA: temporary, least-privilege READ-ONLY login for the one-shot pilot preflight.
-- Run ONCE as the database owner (Railway → etnara-care-staging-db → Database → Query),
-- replacing <PASSWORD> with a password of letters and digits only, generated in your
-- password manager (never paste it in chats).
--
-- * NOBYPASSRLS: every row-level security policy applies. The preflight reads inside the
--   same platform scope ETNARA Central uses (app.is_superadmin + an active platform admin).
-- * No pg_read_all_data: SELECT only on the columns listed below. No clinical columns
--   (names, birth dates, allergies, care plans, notes), no addresses or coordinates,
--   no phone numbers, no password hashes, no tokens.
-- * Every session read-only; one connection; expires by itself in 24 hours.
-- Adds one role and its grants. Changes no table, row, policy or existing grant.
BEGIN;
DO $$ BEGIN
  EXECUTE format(
    'CREATE ROLE etnara_preflight_ro LOGIN PASSWORD %L
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
       CONNECTION LIMIT 1 VALID UNTIL %L',
    '<PASSWORD>', (now() + interval '24 hours')::text);
END $$;
ALTER ROLE etnara_preflight_ro SET default_transaction_read_only = on;
ALTER ROLE etnara_preflight_ro SET statement_timeout = '30s';
ALTER ROLE etnara_preflight_ro SET idle_in_transaction_session_timeout = '60s';

-- Platform scope check used by the RLS policies (app_is_superadmin()).
GRANT SELECT (user_id, revoked_at)                                   ON platform_admins TO etnara_preflight_ro;
-- 1-2. Organization identity, pilot switches and their history (no actor identity).
GRANT SELECT (id, name, organization_type, status, created_at, archived_at) ON organizations TO etnara_preflight_ro;
GRANT SELECT (organization_id, feature_code, enabled, updated_at)     ON organization_features TO etnara_preflight_ro;
GRANT SELECT (organization_id, feature_code, enabled, reason, occurred_at) ON organization_feature_events TO etnara_preflight_ro;
-- 3-4. Roles of the accounts (e-mail only to print its domain), workers' requirements.
GRANT SELECT (id, code)                                              ON roles TO etnara_preflight_ro;
GRANT SELECT (id, user_id, organization_id, status)                  ON organization_memberships TO etnara_preflight_ro;
GRANT SELECT (organization_membership_id, organization_id, role_id)  ON user_roles TO etnara_preflight_ro;
GRANT SELECT (id, email, status)                                     ON users TO etnara_preflight_ro;
GRANT SELECT (id, worker_id, organization_id, status, internal_role) ON organization_worker_memberships TO etnara_preflight_ro;
GRANT SELECT (id, user_id)                                           ON workers TO etnara_preflight_ro;
GRANT SELECT (id, worker_id)                                         ON credentials TO etnara_preflight_ro;
GRANT SELECT (credential_id, organization_id, review_status)         ON organization_credential_reviews TO etnara_preflight_ro;
-- 3. Counts only for people receiving care, relatives and notifications
--    (care_recipient_id is an internal key the RLS policies need; no names).
GRANT SELECT (id, organization_id, archived_at)                      ON care_recipients TO etnara_preflight_ro;
GRANT SELECT (user_id, organization_id, care_recipient_id, status, can_receive_notifications, can_view_service_location) ON family_relationships TO etnara_preflight_ro;
GRANT SELECT (organization_id, created_at)                           ON notifications TO etnara_preflight_ro;
-- Not read by the preflight: keys, statuses and times that the RLS policy of
-- care_recipients (worker-assignment branch) evaluates. No GPS, notes or clinical data.
GRANT SELECT (id, organization_id, status, scheduled_end, care_recipient_id, room_id) ON shifts TO etnara_preflight_ro;
GRANT SELECT (organization_worker_membership_id, shift_id, organization_id, response_status, care_recipient_id) ON assignments TO etnara_preflight_ro;
GRANT SELECT (organization_id, shift_id, organization_worker_membership_id, event_type, occurred_at) ON verification_events TO etnara_preflight_ro;
-- Boolean RLS helper functions referenced by the policies of the tables above
-- (EXECUTE is not granted to PUBLIC in this schema; without these the policies cannot run).
GRANT EXECUTE ON FUNCTION app_has_active_membership()        TO etnara_preflight_ro;
GRANT EXECUTE ON FUNCTION app_is_any_establishment_admin()   TO etnara_preflight_ro;
GRANT EXECUTE ON FUNCTION app_is_org_admin()                 TO etnara_preflight_ro;
GRANT EXECUTE ON FUNCTION app_is_org_manager_definer()       TO etnara_preflight_ro;
GRANT EXECUTE ON FUNCTION app_worker_has_shift_assignment(uuid) TO etnara_preflight_ro;
COMMIT;

-- Check: rolsuper = f, rolbypassrls = f, valid ~24 h; then the exact grant list.
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolconnlimit, rolvaliduntil
  FROM pg_roles WHERE rolname = 'etnara_preflight_ro';
SELECT table_name, string_agg(column_name, ', ' ORDER BY column_name) AS columns
  FROM information_schema.column_privileges
 WHERE grantee = 'etnara_preflight_ro' GROUP BY table_name ORDER BY table_name;

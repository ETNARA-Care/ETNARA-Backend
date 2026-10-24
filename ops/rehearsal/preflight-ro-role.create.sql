-- ETNARA: temporary READ-ONLY access for the one-shot pilot preflight (least privilege).
-- Run ONCE as the database owner in psql (Railway → etnara-care-staging-db → Database →
-- Console). This file contains NO password: the role is created without one (it cannot
-- log in yet). Then set it interactively with psql's  \password etnara_preflight_ro
-- psql asks twice with hidden input and sends only a SCRAM hash, so the password never
-- appears in this SQL, the psql history, server logs or the screen.
--
-- Design:
-- * The login etnara_preflight_ro gets NO privilege on any table. Its only privilege is
--   EXECUTE on etnara_preflight.pilot_summary(), a fixed, read-only summary of ONE
--   organization (hard-coded below) plus the pilot-switch state of the other agencies.
-- * The summary returns organization identity, switches and their on/off history (code,
--   state, time; no free-text reason), roles with the e-mail DOMAIN only, worker
--   requirement flags and counts. It never returns names, birth
--   dates, clinical data, addresses, coordinates, phones, password hashes or tokens.
-- * SECURITY DEFINER hardening: fixed search_path (pg_catalog, pg_temp) and every table
--   schema-qualified, so the login cannot shadow anything; it has no CREATE on public or
--   etnara_preflight, and pg_temp is searched last (never for functions/operators).
-- * Setting app.is_superadmin / app.current_user_id gives this login nothing: with no table
--   privileges every SELECT is "permission denied" before any RLS policy is evaluated.
-- * Every session read-only (the function runs inside that read-only transaction too);
--   one connection. VALID UNTIL only stops NEW logins after 24 h: it does NOT drop the
--   role, its grants or the schema; run preflight-ro-role.drop.sql to remove them.
-- Adds one role, one schema and one function. Changes no existing table, row, policy,
-- function or grant.
BEGIN;
DO $$ BEGIN
  EXECUTE format(
    'CREATE ROLE etnara_preflight_ro LOGIN PASSWORD NULL
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
       CONNECTION LIMIT 1 VALID UNTIL %L',
    (now() + interval '24 hours')::text);
END $$;
ALTER ROLE etnara_preflight_ro SET default_transaction_read_only = on;
ALTER ROLE etnara_preflight_ro SET statement_timeout = '30s';
ALTER ROLE etnara_preflight_ro SET idle_in_transaction_session_timeout = '60s';

CREATE SCHEMA etnara_preflight;                       -- owned by the database owner
REVOKE ALL ON SCHEMA etnara_preflight FROM PUBLIC;

CREATE FUNCTION etnara_preflight.pilot_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp     -- every table below is schema-qualified (public.*); pg_temp last
AS $fn$
  WITH p AS (SELECT '41952e30-6d9e-4ded-b5a7-727c43fe9ffb'::uuid AS org)
  SELECT jsonb_build_object(
    'organization', (SELECT jsonb_build_object('id', o.id, 'name', o.name, 'type', o.organization_type,
                       'status', o.status, 'created_at', o.created_at, 'archived_at', o.archived_at)
                     FROM public.organizations o, p WHERE o.id = p.org),
    'features', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', f.feature_code, 'enabled', f.enabled,
                   'updated_at', f.updated_at) ORDER BY f.feature_code), '[]')
                 FROM public.organization_features f, p WHERE f.organization_id = p.org),
    'feature_history', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', e.feature_code, 'enabled', e.enabled,
                          'at', e.occurred_at) ORDER BY e.occurred_at), '[]')
                        FROM public.organization_feature_events e, p WHERE e.organization_id = p.org),
    'members', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'roles', x->>'email_domain'), '[]') FROM (
                  SELECT jsonb_build_object(
                    'email_domain', coalesce(nullif(split_part(u.email, '@', 2), ''), '(sin correo)'),
                    'membership', m.status, 'user', u.status,
                    'roles', (SELECT coalesce(string_agg(r.code, ',' ORDER BY r.code), '')
                              FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
                              WHERE ur.organization_membership_id = m.id AND ur.organization_id = m.organization_id)) x
                  FROM public.organization_memberships m JOIN public.users u ON u.id = m.user_id, p
                  WHERE m.organization_id = p.org) s),
    'workers', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'status', owm.status, 'role', owm.internal_role, 'has_login', w.user_id IS NOT NULL,
                  'credential_approved', EXISTS (SELECT 1 FROM public.credentials c
                      JOIN public.organization_credential_reviews rv ON rv.credential_id = c.id
                      WHERE c.worker_id = owm.worker_id AND rv.organization_id = owm.organization_id
                        AND rv.review_status = 'approved'),
                  'availability_set', EXISTS (SELECT 1 FROM public.worker_weekly_availability a
                      WHERE a.organization_worker_membership_id = owm.id AND a.organization_id = owm.organization_id))
                  ORDER BY owm.status, owm.internal_role), '[]')
                FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id, p
                WHERE owm.organization_id = p.org),
    'care_recipients', (SELECT jsonb_build_object(
                          'active', count(*) FILTER (WHERE cr.archived_at IS NULL), 'total', count(*),
                          'with_confirmed_address', (SELECT count(*) FROM public.care_recipient_locations l
                              WHERE l.organization_id = p.org AND l.address_line IS NOT NULL),
                          'with_map_point', (SELECT count(*) FROM public.care_recipient_locations l
                              WHERE l.organization_id = p.org AND l.latitude IS NOT NULL))
                        FROM p LEFT JOIN public.care_recipients cr ON cr.organization_id = p.org GROUP BY p.org),
    'family', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'email_domain', coalesce(nullif(split_part(u.email, '@', 2), ''), '(sin correo)'),
                 'status', f.status, 'notifications', f.can_receive_notifications,
                 'address_permission', f.can_view_service_location)
                 ORDER BY f.status), '[]')
               FROM public.family_relationships f LEFT JOIN public.users u ON u.id = f.user_id, p
               WHERE f.organization_id = p.org),
    'notifications_7d', (SELECT count(*) FROM public.notifications n, p
                         WHERE n.organization_id = p.org AND n.created_at > now() - interval '7 days'),
    'other_organizations', (SELECT jsonb_build_object(
                              'count', count(*),
                              'with_any_feature_on', count(*) FILTER (WHERE EXISTS (
                                  SELECT 1 FROM public.organization_features f WHERE f.organization_id = o.id AND f.enabled)),
                              'enabled', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', o2.id, 'name', o2.name,
                                  'code', f2.feature_code)), '[]')
                                  FROM public.organization_features f2 JOIN public.organizations o2 ON o2.id = f2.organization_id
                                  WHERE f2.enabled AND o2.id <> p.org))
                            FROM public.organizations o, p WHERE o.id <> p.org GROUP BY p.org)
  )
  FROM p;
$fn$;

REVOKE ALL ON FUNCTION etnara_preflight.pilot_summary() FROM PUBLIC;   -- functions default to PUBLIC EXECUTE
GRANT USAGE ON SCHEMA etnara_preflight TO etnara_preflight_ro;
GRANT EXECUTE ON FUNCTION etnara_preflight.pilot_summary() TO etnara_preflight_ro;
COMMIT;

-- Checks (all must hold):
-- 1. role: rolsuper = f, rolbypassrls = f, rolcanlogin = t, valid ~24 h.
--    (rolpassword is still NULL here: run  \password etnara_preflight_ro  next.)
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcanlogin, rolconnlimit, rolvaliduntil
  FROM pg_roles WHERE rolname = 'etnara_preflight_ro';
-- 2. table/column privileges granted to the role: must be 0 rows.
SELECT table_schema, table_name, privilege_type FROM information_schema.table_privileges  WHERE grantee = 'etnara_preflight_ro'
UNION ALL
SELECT table_schema, table_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'etnara_preflight_ro';
-- 3. its only grants: USAGE on the schema and EXECUTE on the one function.
SELECT 'schema' AS kind, nspname AS object FROM pg_namespace WHERE has_schema_privilege('etnara_preflight_ro', oid, 'USAGE') AND nspname = 'etnara_preflight'
UNION ALL
SELECT 'function', p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'etnara_preflight' AND has_function_privilege('etnara_preflight_ro', p.oid, 'EXECUTE');

-- ETNARA: remove the temporary preflight access. Safe to run twice.
-- Note: VALID UNTIL only blocks new logins after 24 h; it does NOT remove the role, its
-- grants, the schema or the function. This script removes all of them.
-- No DROP OWNED and no CASCADE: privileges are revoked explicitly, each object is dropped
-- by name, and the role is dropped only after proving it owns nothing and holds no
-- privilege anywhere.

-- 1. Close any open session of the login.
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'etnara_preflight_ro';

BEGIN;
-- 2. Revoke explicitly the only two privileges the login was given.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etnara_preflight_ro') THEN
    IF to_regprocedure('etnara_preflight.pilot_summary()') IS NOT NULL THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION etnara_preflight.pilot_summary() FROM etnara_preflight_ro';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'etnara_preflight') THEN
      EXECUTE 'REVOKE USAGE ON SCHEMA etnara_preflight FROM etnara_preflight_ro';
    END IF;
  END IF;
END $$;

-- 3. Remove the summary function and its schema (owned by the database owner, not by the role).
DROP FUNCTION IF EXISTS etnara_preflight.pilot_summary();
DROP SCHEMA IF EXISTS etnara_preflight RESTRICT;      -- fails if anything else was put in it

-- 4. Prove the role owns nothing and has no remaining privilege, then drop it.
DO $$
DECLARE r oid; owned int; acl int;
BEGIN
  SELECT oid INTO r FROM pg_roles WHERE rolname = 'etnara_preflight_ro';
  IF r IS NULL THEN RAISE NOTICE 'etnara_preflight_ro already removed'; RETURN; END IF;
  SELECT count(*) INTO owned FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = r AND deptype = 'o';
  SELECT count(*) INTO acl   FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = r AND deptype = 'a';
  IF owned > 0 THEN RAISE EXCEPTION 'etnara_preflight_ro OWNS % object(s): stop and review (nothing was dropped)', owned; END IF;
  IF acl   > 0 THEN RAISE EXCEPTION 'etnara_preflight_ro still has % privilege entr(y/ies): stop and review (nothing was dropped)', acl; END IF;
  EXECUTE 'DROP ROLE etnara_preflight_ro';
END $$;
COMMIT;

-- 5. Checks: all must be 0.
SELECT (SELECT count(*) FROM pg_roles     WHERE rolname = 'etnara_preflight_ro') AS role_remaining,
       (SELECT count(*) FROM pg_namespace WHERE nspname = 'etnara_preflight')    AS schema_remaining,
       (SELECT count(*) FROM pg_proc      WHERE proname = 'pilot_summary')       AS function_remaining;

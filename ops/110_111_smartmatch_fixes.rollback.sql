-- ROLLBACK of migration 110 (SmartMatch fixes). Migration 111 is NOT rolled back.
--
-- Run ONLY together with redeploying the previous backend (8274cce), as the
-- database owner, in one go. Never needed for a code-only rollback: 110 and 111
-- are compatible with the previous backend (it simply does not call the new
-- functions). Roll back the CODE first; run this only if the database objects
-- of 110 themselves must go. Procedure: ops/110_111_smartmatch_fixes.rollback.md
--
-- Security: migration 111 (password_reset_tokens reachable by app_runtime only)
-- is a security fix and stays. This script never grants anything to PUBLIC and
-- aborts (nothing changed) if PUBLIC holds any privilege on password_reset_tokens
-- or if app_runtime lost the access password recovery needs.

BEGIN;

-- 0. Preconditions: password recovery must be reachable by app_runtime only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'app_runtime role missing: rollback aborted, nothing changed';
  END IF;
  IF NOT (has_table_privilege('app_runtime', 'public.password_reset_tokens', 'SELECT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'INSERT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'UPDATE')) THEN
    RAISE EXCEPTION 'app_runtime lacks SELECT/INSERT/UPDATE on password_reset_tokens: fix it first (see the runbook), rollback aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.password_reset_tokens'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC holds privileges on password_reset_tokens: revoke them first (see the runbook), rollback aborted';
  END IF;
END $$;

-- 1. The old constraint (start < end) cannot be restored while overnight windows
-- exist. Stop if there are any: the agency must edit them first (or keep 110).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM worker_weekly_availability WHERE end_time <= start_time) THEN
    RAISE EXCEPTION 'overnight availability windows exist (%): rollback aborted, nothing changed',
      (SELECT count(*) FROM worker_weekly_availability WHERE end_time <= start_time);
  END IF;
END $$;

-- 2. 110: functions (unused by the previous backend) and the constraint.
DROP FUNCTION IF EXISTS public.app_smartmatch_worker_has_commitment(uuid, timestamptz, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.app_availability_covers(uuid, timestamptz, timestamptz);
ALTER TABLE worker_weekly_availability DROP CONSTRAINT IF EXISTS worker_weekly_availability_nonzero;
ALTER TABLE worker_weekly_availability ADD CONSTRAINT worker_weekly_availability_check CHECK (start_time < end_time);

-- 3. Only 110 is unregistered (re-applied by the next deploy if rolled forward).
-- 111 stays registered and applied.
DELETE FROM schema_migrations WHERE filename = '110_schedule_commitments_and_overnight_availability.sql';

-- 4. Postconditions, same transaction: nothing reopened to PUBLIC.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.password_reset_tokens'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC would hold privileges on password_reset_tokens: rollback aborted';
  END IF;
  IF NOT (has_table_privilege('app_runtime', 'public.password_reset_tokens', 'SELECT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'INSERT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'UPDATE')) THEN
    RAISE EXCEPTION 'app_runtime would lose access to password_reset_tokens: rollback aborted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '111_password_reset_tokens_runtime_only.sql') THEN
    RAISE EXCEPTION 'migration 111 must stay registered: rollback aborted';
  END IF;
END $$;

COMMIT;

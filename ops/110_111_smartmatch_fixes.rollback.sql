-- ROLLBACK of migrations 110 + 111 (SmartMatch fixes). Run ONLY together with
-- redeploying the previous backend (8274cce), as the database owner, in one go.
-- Never needed for a code-only rollback: 110 and 111 are compatible with the
-- previous backend (it simply does not call the new functions).
--
-- Order matters: the previous code still works with 110/111 applied, so roll back
-- the CODE first; run this only if the database objects themselves must go.

BEGIN;

-- 111: give password_reset_tokens back to PUBLIC exactly as migration 074 left it.
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO PUBLIC;

-- 110: functions (unused by the previous backend).
DROP FUNCTION IF EXISTS public.app_smartmatch_worker_has_commitment(uuid, timestamptz, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.app_availability_covers(uuid, timestamptz, timestamptz);

-- 110: the old constraint (start < end) cannot be restored while overnight windows
-- exist. Stop if there are any: the agency must edit them first (or keep 110's constraint).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM worker_weekly_availability WHERE end_time <= start_time) THEN
    RAISE EXCEPTION 'overnight availability windows exist (%): restore aborted, nothing changed',
      (SELECT count(*) FROM worker_weekly_availability WHERE end_time <= start_time);
  END IF;
END $$;
ALTER TABLE worker_weekly_availability DROP CONSTRAINT IF EXISTS worker_weekly_availability_nonzero;
ALTER TABLE worker_weekly_availability ADD CONSTRAINT worker_weekly_availability_check CHECK (start_time < end_time);

DELETE FROM schema_migrations
 WHERE filename IN ('110_schedule_commitments_and_overnight_availability.sql', '111_password_reset_tokens_runtime_only.sql');

COMMIT;

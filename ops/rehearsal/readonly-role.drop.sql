-- ETNARA: remove the temporary read-only role (run right after the backup/rehearsal,
-- or at any time to abort). Safe to run twice.
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'etnara_rehearsal_ro';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etnara_rehearsal_ro') THEN
    REVOKE pg_read_all_data FROM etnara_rehearsal_ro;
    DROP ROLE etnara_rehearsal_ro;
  END IF;
END $$;
-- Check: must return 0
SELECT count(*) AS remaining FROM pg_roles WHERE rolname = 'etnara_rehearsal_ro';

-- ETNARA: remove the temporary preflight login. Safe to run twice.
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'etnara_preflight_ro';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etnara_preflight_ro') THEN
    REVOKE pg_read_all_data FROM etnara_preflight_ro;
    DROP ROLE etnara_preflight_ro;
  END IF;
END $$;
SELECT count(*) AS remaining FROM pg_roles WHERE rolname = 'etnara_preflight_ro';  -- must be 0

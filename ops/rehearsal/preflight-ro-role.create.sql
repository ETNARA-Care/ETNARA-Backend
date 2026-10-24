-- ETNARA: temporary READ-ONLY login for the one-shot pilot preflight.
-- Run ONCE as the database owner (Railway → etnara-care-staging-db → Database → Query),
-- after replacing <PASSWORD> with a password of letters and digits only (no symbols),
-- generated in your password manager. Never paste it in chats.
-- Adds one role that expires by itself in 24 hours. Changes no table, row,
-- policy, grant or setting of any existing role.
BEGIN;
DO $$ BEGIN
  EXECUTE format(
    'CREATE ROLE etnara_preflight_ro LOGIN PASSWORD %L
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
       BYPASSRLS CONNECTION LIMIT 1 VALID UNTIL %L',
    '<PASSWORD>', (now() + interval '24 hours')::text);
END $$;
GRANT pg_read_all_data TO etnara_preflight_ro;      -- SELECT only
ALTER ROLE etnara_preflight_ro SET default_transaction_read_only = on;
ALTER ROLE etnara_preflight_ro SET statement_timeout = '30s';
COMMIT;
-- Check: one row, rolsuper = f, rolvaliduntil about 24 h ahead.
SELECT rolname, rolsuper, rolbypassrls, rolconnlimit, rolvaliduntil FROM pg_roles WHERE rolname = 'etnara_preflight_ro';

-- ETNARA: temporary READ-ONLY role for the verified backup / migration rehearsal.
-- Run ONCE as the database owner (Railway → etnara-care-staging-db → Database → query),
-- after replacing <PASSWORD_FROM_YOUR_PASSWORD_MANAGER> (never paste it in chats or tickets).
-- Changes nothing in the application: no table, row, policy, grant or setting of
-- existing roles. Adds one role that expires by itself in 24 hours.
BEGIN;
DO $$ BEGIN
  EXECUTE format(
    'CREATE ROLE etnara_rehearsal_ro LOGIN PASSWORD %L
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
       BYPASSRLS CONNECTION LIMIT 3 VALID UNTIL %L',
    '<PASSWORD_FROM_YOUR_PASSWORD_MANAGER>', (now() + interval '24 hours')::text);
END $$;
-- SELECT on every table/sequence; no INSERT/UPDATE/DELETE/TRUNCATE/DDL.
GRANT pg_read_all_data TO etnara_rehearsal_ro;
-- Every transaction read-only, so not even a SECURITY DEFINER function can write.
ALTER ROLE etnara_rehearsal_ro SET default_transaction_read_only = on;
ALTER ROLE etnara_rehearsal_ro SET statement_timeout = '15min';
ALTER ROLE etnara_rehearsal_ro SET idle_in_transaction_session_timeout = '15min';
COMMIT;
-- Check: one row, rolbypassrls = t, rolsuper = f, rolvaliduntil about 24 h ahead.
SELECT rolname, rolsuper, rolbypassrls, rolconnlimit, rolvaliduntil FROM pg_roles WHERE rolname = 'etnara_rehearsal_ro';

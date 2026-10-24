-- Migration 111: password_reset_tokens is reachable by the application role only.
--
-- Migration 074 granted SELECT, INSERT, UPDATE to PUBLIC, i.e. to EVERY database
-- login. Row-level security still applied, but any login able to set
-- app.current_user_id could read another user's reset-token hashes. The API
-- connects as app_runtime, so that is the only role that needs the table.
--
-- Fail closed: if app_runtime does not exist the migration aborts (nothing is
-- revoked), so password recovery can never be left without a role that reaches it.
-- RLS policies (072/073) are unchanged.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'app_runtime role missing: refusing to revoke PUBLIC access to password_reset_tokens';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO app_runtime;
REVOKE ALL ON password_reset_tokens FROM PUBLIC;

-- Prove the effective privileges inside the same transaction.
DO $$
BEGIN
  IF NOT (has_table_privilege('app_runtime', 'public.password_reset_tokens', 'SELECT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'INSERT')
      AND has_table_privilege('app_runtime', 'public.password_reset_tokens', 'UPDATE')) THEN
    RAISE EXCEPTION 'app_runtime lost access to password_reset_tokens';
  END IF;
  IF has_table_privilege('app_runtime', 'public.password_reset_tokens', 'DELETE')
     OR has_table_privilege('app_runtime', 'public.password_reset_tokens', 'TRUNCATE') THEN
    RAISE EXCEPTION 'app_runtime must not delete or truncate password_reset_tokens';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.password_reset_tokens'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC still has privileges on password_reset_tokens';
  END IF;
END $$;

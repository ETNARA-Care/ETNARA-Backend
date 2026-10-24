-- ROLLBACK of migration 117 (phone linked to the account, SMS recovery).
-- Run ONLY before the feature was used, as the database owner, in one go. A code-only
-- rollback does not need it (PHONE_VERIFICATION_ENABLED=false turns every phone route off).
-- Stops, changing nothing, if any phone was verified or any SMS code was issued.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE phone_verified_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM account_phone_challenges) OR EXISTS (SELECT 1 FROM sms_send_log) THEN
    RAISE EXCEPTION 'phones were verified or SMS codes were issued: rollback aborted, nothing changed';
  END IF;
END $$;

-- Family invitations by phone: back to the 104 definition.
CREATE OR REPLACE FUNCTION app_family_invitation_allows_self_insert(
  p_invitation_id uuid, p_organization_id uuid, p_care_recipient_id uuid,
  p_relationship_type text, p_can_view_photos boolean
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM family_invitations i
    JOIN users u ON u.id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    WHERE i.id = p_invitation_id
      AND i.organization_id = p_organization_id
      AND i.care_recipient_id = p_care_recipient_id
      AND i.status::text = 'pending'
      AND i.expires_at > now()
      AND i.relationship_type::text IS NOT DISTINCT FROM p_relationship_type
      AND i.can_view_photos IS NOT DISTINCT FROM p_can_view_photos
      AND (
        (i.email IS NOT NULL AND u.email IS NOT NULL AND lower(i.email) = lower(u.email))
        OR (i.phone IS NOT NULL AND u.phone IS NOT NULL AND i.phone = u.phone)
      )
  );
$$;
REVOKE ALL ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) TO app_runtime;

DROP FUNCTION IF EXISTS app_phone_reset_complete(uuid, text);
DROP FUNCTION IF EXISTS app_phone_reset_start(text, text, text);
DROP FUNCTION IF EXISTS app_phone_verification_complete(uuid);
DROP FUNCTION IF EXISTS app_phone_challenge_failed(uuid);
DROP FUNCTION IF EXISTS app_phone_challenge_attempt(account_phone_purpose, text);
DROP FUNCTION IF EXISTS app_phone_verification_start(uuid, text, text, text);
DROP FUNCTION IF EXISTS app_session_mark_reauthenticated(uuid);
DROP FUNCTION IF EXISTS app_account_security_state();
DROP FUNCTION IF EXISTS app_sms_rate_check(text, text, account_phone_purpose, integer);
DROP FUNCTION IF EXISTS app_acct_ctx_user();
DROP TABLE IF EXISTS account_security_events;
DROP FUNCTION IF EXISTS app_account_security_events_append_only();
DROP TABLE IF EXISTS sms_send_log;
DROP TABLE IF EXISTS account_phone_challenges;
DROP TYPE IF EXISTS account_phone_purpose;
ALTER TABLE sessions DROP COLUMN IF EXISTS reauthenticated_at;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_verified_needs_phone;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_e164_nanp;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE users DROP COLUMN IF EXISTS phone_changed_at;
ALTER TABLE users DROP COLUMN IF EXISTS phone_verified_at;

DELETE FROM schema_migrations WHERE filename = '117_account_phone_verification.sql';

COMMIT;

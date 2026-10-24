-- Migration 117: phone linked to the account, verified by SMS code; SMS password recovery.
-- Approved design 24-oct-2026 (Rafa). The e-mail stays: both are linked to the same account.
--
-- Nothing here sends SMS. The API only uses these functions when
-- PHONE_VERIFICATION_ENABLED=true AND an SMS provider is configured (off by default).
--
--  * users: phone_verified_at, phone_changed_at, email_verified_at (activation by
--    e-mailed invitation proves the address). A phone that is NOT verified is never
--    used to log in, to recover, or to match an invitation.
--  * account_phone_challenges: one active code per user and purpose; only an HMAC of
--    the code (or nothing, when the provider keeps the code); 10 min; 5 attempts.
--  * sms_send_log: limits per phone, per IP and per day in the DATABASE (not process
--    memory), counted the same whether or not the number has an account.
--  * account_security_events: append-only history (no codes, no full numbers).
--  * sessions.reauthenticated_at: a phone change needs a password entered < 10 min ago.
--  * SMS recovery is suspended for 72 h after a phone change (e-mail recovery still works).
--  * app_runtime gets NO table privileges on the new tables: only the functions below.

-- ---------------------------------------------------------------- users / sessions
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
-- New or changed numbers must be E.164 +1 (Puerto Rico 787/939 and the US). Existing
-- free-text values are left untouched (NOT VALID) and count as unverified.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_e164_nanp;
ALTER TABLE users ADD CONSTRAINT users_phone_e164_nanp
  CHECK (phone IS NULL OR phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$') NOT VALID;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_verified_needs_phone;
ALTER TABLE users ADD CONSTRAINT users_phone_verified_needs_phone
  CHECK (phone_verified_at IS NULL OR phone IS NOT NULL);
-- Accounts were created by activating an invitation sent to their e-mail.
UPDATE users SET email_verified_at = created_at
 WHERE email IS NOT NULL AND password_hash IS NOT NULL AND email_verified_at IS NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauthenticated_at timestamptz;

-- ---------------------------------------------------------------- tables
DO $$ BEGIN
  CREATE TYPE account_phone_purpose AS ENUM ('VERIFY', 'RESET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_phone_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       account_phone_purpose NOT NULL,
  phone         text NOT NULL CHECK (phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  code_hash     text,              -- HMAC-SHA256 of the code (local provider); NULL when the provider keeps it
  provider      text NOT NULL CHECK (provider IN ('test', 'twilio_verify')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_phone_challenge_active
  ON account_phone_challenges (user_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_account_phone_challenge_phone ON account_phone_challenges (phone, purpose) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS sms_send_log (
  id          bigserial PRIMARY KEY,
  phone_hash  text NOT NULL,
  ip_hash     text,
  purpose     account_phone_purpose NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_phone ON sms_send_log (phone_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_ip ON sms_send_log (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_send_log_day ON sms_send_log (created_at DESC);

CREATE TABLE IF NOT EXISTS account_security_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event       text NOT NULL CHECK (event IN ('PHONE_VERIFIED', 'PHONE_CHANGED', 'PHONE_CODE_FAILED', 'PHONE_CODE_LOCKED',
                                             'SMS_RESET_ISSUED', 'SMS_RESET_VERIFIED', 'REAUTHENTICATED')),
  phone_last4 text CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_security_events_user ON account_security_events (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION app_account_security_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'ACCOUNT_SECURITY_EVENTS_APPEND_ONLY' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS trg_account_security_events_append_only ON account_security_events;
CREATE TRIGGER trg_account_security_events_append_only BEFORE UPDATE OR DELETE ON account_security_events
  FOR EACH ROW EXECUTE FUNCTION app_account_security_events_append_only();

-- No direct access for the app (no privileges at all); only the SECURITY DEFINER functions below.
ALTER TABLE account_phone_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_security_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_phone_challenges, sms_send_log, account_security_events FROM PUBLIC;
REVOKE ALL ON account_phone_challenges, sms_send_log, account_security_events FROM app_runtime;
REVOKE ALL ON SEQUENCE sms_send_log_id_seq, account_security_events_id_seq FROM PUBLIC;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION app_acct_ctx_user() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app_acct_ctx_user() FROM PUBLIC;

-- Limits, counted on the NUMBER (hash) and the IP whether or not an account exists,
-- so a 429 never tells an account from a non-account. Records the attempt.
CREATE OR REPLACE FUNCTION app_sms_rate_check(p_phone_hash text, p_ip_hash text, p_purpose account_phone_purpose, p_daily_cap integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_phone_hash !~ '^[0-9a-f]{64}$' OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'SMS_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sms:' || p_phone_hash, 0));
  IF EXISTS (SELECT 1 FROM sms_send_log WHERE phone_hash = p_phone_hash AND created_at > now() - interval '60 seconds')
     OR (SELECT count(*) FROM sms_send_log WHERE phone_hash = p_phone_hash AND created_at > now() - interval '1 hour') >= 3
     OR (SELECT count(*) FROM sms_send_log WHERE phone_hash = p_phone_hash AND created_at > now() - interval '24 hours') >= 5
     OR (p_ip_hash IS NOT NULL AND (SELECT count(*) FROM sms_send_log WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour') >= 10)
     OR (SELECT count(*) FROM sms_send_log WHERE created_at > now() - interval '24 hours') >= GREATEST(p_daily_cap, 1) THEN
    RAISE EXCEPTION 'SMS_RATE_LIMITED' USING ERRCODE = '54000';
  END IF;
  INSERT INTO sms_send_log (phone_hash, ip_hash, purpose) VALUES (p_phone_hash, p_ip_hash, p_purpose);
END $$;
REVOKE ALL ON FUNCTION app_sms_rate_check(text, text, account_phone_purpose, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_sms_rate_check(text, text, account_phone_purpose, integer) TO app_runtime;

-- The signed-in user's own security state (masked by the API).
CREATE OR REPLACE FUNCTION app_account_security_state()
RETURNS TABLE (email text, phone text, phone_verified_at timestamptz, phone_changed_at timestamptz, created_at timestamptz, staff boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.email, u.phone, u.phone_verified_at, u.phone_changed_at, u.created_at,
         EXISTS (SELECT 1 FROM organization_memberships m JOIN user_roles ur ON ur.organization_membership_id = m.id
                 JOIN roles r ON r.id = ur.role_id
                  WHERE m.user_id = u.id AND m.status = 'active' AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR', 'WORKER'))
    FROM users u
   WHERE u.id = app_acct_ctx_user() AND u.status = 'active' AND NOT app_is_superadmin()
$$;
REVOKE ALL ON FUNCTION app_account_security_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_account_security_state() TO app_runtime;

-- Re-authentication marks the CURRENT session (the API checks the password first).
CREATE OR REPLACE FUNCTION app_session_mark_reauthenticated(p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user uuid := app_acct_ctx_user();
BEGIN
  UPDATE sessions SET reauthenticated_at = now()
   WHERE id = p_session_id AND user_id = v_user AND revoked_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  INSERT INTO account_security_events (user_id, event) VALUES (v_user, 'REAUTHENTICATED');
END $$;
REVOKE ALL ON FUNCTION app_session_mark_reauthenticated(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_session_mark_reauthenticated(uuid) TO app_runtime;

-- ---------------------------------------------------------------- link / change the phone (signed in)
CREATE OR REPLACE FUNCTION app_phone_verification_start(p_session_id uuid, p_phone text, p_code_hash text, p_provider text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user uuid := app_acct_ctx_user();
BEGIN
  IF v_user IS NULL OR app_is_superadmin() THEN RAISE EXCEPTION 'PHONE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user AND status = 'active') THEN RAISE EXCEPTION 'PHONE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  -- Changing the number needs the password entered less than 10 minutes ago, in THIS session.
  IF NOT EXISTS (SELECT 1 FROM sessions WHERE id = p_session_id AND user_id = v_user AND revoked_at IS NULL
                   AND expires_at > now() AND reauthenticated_at > now() - interval '10 minutes') THEN
    RAISE EXCEPTION 'REAUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RAISE EXCEPTION 'PHONE_INVALID' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = v_user AND phone = p_phone AND phone_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PHONE_ALREADY_VERIFIED' USING ERRCODE = '23505';
  END IF;
  IF p_provider = 'test' AND (p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'PHONE_INVALID' USING ERRCODE = '22023'; END IF;
  -- A new code replaces any earlier one.
  UPDATE account_phone_challenges SET consumed_at = now() WHERE user_id = v_user AND purpose = 'VERIFY' AND consumed_at IS NULL;
  INSERT INTO account_phone_challenges (user_id, purpose, phone, code_hash, provider, expires_at)
  VALUES (v_user, 'VERIFY', p_phone, p_code_hash, p_provider, now() + interval '10 minutes');
END $$;
REVOKE ALL ON FUNCTION app_phone_verification_start(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_verification_start(uuid, text, text, text) TO app_runtime;

-- One attempt: counts it BEFORE the code is checked and returns what the API needs to check it.
CREATE OR REPLACE FUNCTION app_phone_challenge_attempt(p_purpose account_phone_purpose, p_phone text)
RETURNS TABLE (challenge_id uuid, code_hash text, provider text, phone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record; v_user uuid := app_acct_ctx_user();
BEGIN
  IF p_purpose = 'VERIFY' THEN
    IF v_user IS NULL OR app_is_superadmin() THEN RAISE EXCEPTION 'CODE_INVALID' USING ERRCODE = '22023'; END IF;
    SELECT * INTO c FROM account_phone_challenges ch
     WHERE ch.user_id = v_user AND ch.purpose = 'VERIFY' AND ch.consumed_at IS NULL FOR UPDATE;
  ELSE
    -- Recovery: the number written must be the account's VERIFIED number, the account active,
    -- and no phone change in the last 72 h. Any other case looks exactly like a wrong code.
    SELECT ch.* INTO c FROM account_phone_challenges ch JOIN users u ON u.id = ch.user_id
     WHERE ch.purpose = 'RESET' AND ch.phone = p_phone AND ch.consumed_at IS NULL
       AND u.phone = p_phone AND u.phone_verified_at IS NOT NULL AND u.status = 'active'
       AND (u.phone_changed_at IS NULL OR u.phone_changed_at < now() - interval '72 hours')
     FOR UPDATE OF ch;
  END IF;
  IF NOT FOUND OR c.expires_at <= now() OR c.attempts >= c.max_attempts THEN
    RAISE EXCEPTION 'CODE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE account_phone_challenges SET attempts = attempts + 1 WHERE id = c.id;
  challenge_id := c.id; code_hash := c.code_hash; provider := c.provider; phone := c.phone;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app_phone_challenge_attempt(account_phone_purpose, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_challenge_attempt(account_phone_purpose, text) TO app_runtime;

-- A wrong code: history; the last allowed attempt locks the code.
CREATE OR REPLACE FUNCTION app_phone_challenge_failed(p_challenge_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM account_phone_challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO account_security_events (user_id, event, phone_last4)
  VALUES (c.user_id, CASE WHEN c.attempts >= c.max_attempts THEN 'PHONE_CODE_LOCKED' ELSE 'PHONE_CODE_FAILED' END, right(c.phone, 4));
  IF c.attempts >= c.max_attempts THEN UPDATE account_phone_challenges SET consumed_at = now() WHERE id = c.id; END IF;
END $$;
REVOKE ALL ON FUNCTION app_phone_challenge_failed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_challenge_failed(uuid) TO app_runtime;

-- Correct code for linking: the number becomes the account's verified phone.
-- If another account still holds that number UNVERIFIED (legacy free text), it loses it:
-- possession was just proven. A number VERIFIED by another account is never taken.
CREATE OR REPLACE FUNCTION app_phone_verification_complete(p_challenge_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record; v_user uuid := app_acct_ctx_user(); v_old text; v_old_verified timestamptz;
BEGIN
  SELECT * INTO c FROM account_phone_challenges WHERE id = p_challenge_id AND user_id = v_user AND purpose = 'VERIFY'
     AND consumed_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CODE_INVALID' USING ERRCODE = '22023'; END IF;
  UPDATE account_phone_challenges SET consumed_at = now() WHERE id = c.id;
  PERFORM pg_advisory_xact_lock(hashtextextended('phone:' || c.phone, 0));
  IF EXISTS (SELECT 1 FROM users WHERE phone = c.phone AND id <> v_user AND phone_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'PHONE_UNAVAILABLE' USING ERRCODE = '23505';
  END IF;
  UPDATE users SET phone = NULL WHERE phone = c.phone AND id <> v_user AND phone_verified_at IS NULL;
  SELECT phone, phone_verified_at INTO v_old, v_old_verified FROM users WHERE id = v_user FOR UPDATE;
  UPDATE users SET phone = c.phone, phone_verified_at = now(),
         -- Replacing a verified number starts the 72 h pause of SMS recovery.
         phone_changed_at = CASE WHEN v_old_verified IS NOT NULL AND v_old IS DISTINCT FROM c.phone THEN now() ELSE phone_changed_at END
   WHERE id = v_user;
  INSERT INTO account_security_events (user_id, event, phone_last4)
  VALUES (v_user, CASE WHEN v_old_verified IS NOT NULL AND v_old IS DISTINCT FROM c.phone THEN 'PHONE_CHANGED' ELSE 'PHONE_VERIFIED' END, right(c.phone, 4));
  -- Pending recovery codes for the old number are cancelled.
  UPDATE account_phone_challenges SET consumed_at = now() WHERE user_id = v_user AND purpose = 'RESET' AND consumed_at IS NULL;
  RETURN CASE WHEN v_old_verified IS NOT NULL AND v_old IS DISTINCT FROM c.phone THEN 'CHANGED' ELSE 'VERIFIED' END;
END $$;
REVOKE ALL ON FUNCTION app_phone_verification_complete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_verification_complete(uuid) TO app_runtime;

-- ---------------------------------------------------------------- SMS password recovery (signed out)
-- Creates a code ONLY for an active account whose VERIFIED phone is exactly this number and
-- that did not change it in the last 72 h. Returns whether an SMS must be sent; the API never
-- tells the caller (same answer either way).
CREATE OR REPLACE FUNCTION app_phone_reset_start(p_phone text, p_code_hash text, p_provider text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user uuid;
BEGIN
  IF p_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' THEN RETURN false; END IF;
  SELECT id INTO v_user FROM users
   WHERE phone = p_phone AND phone_verified_at IS NOT NULL AND status = 'active' AND password_hash IS NOT NULL
     AND (phone_changed_at IS NULL OR phone_changed_at < now() - interval '72 hours');
  IF v_user IS NULL THEN RETURN false; END IF;
  IF p_provider = 'test' AND (p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
  UPDATE account_phone_challenges SET consumed_at = now() WHERE user_id = v_user AND purpose = 'RESET' AND consumed_at IS NULL;
  INSERT INTO account_phone_challenges (user_id, purpose, phone, code_hash, provider, expires_at)
  VALUES (v_user, 'RESET', p_phone, p_code_hash, p_provider, now() + interval '10 minutes');
  INSERT INTO account_security_events (user_id, event, phone_last4) VALUES (v_user, 'SMS_RESET_ISSUED', right(p_phone, 4));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app_phone_reset_start(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_reset_start(text, text, text) TO app_runtime;

-- Correct recovery code: the SAME single-use, 10-minute password-reset token as the e-mail
-- path is issued (the existing confirm step sets the password and closes every session).
CREATE OR REPLACE FUNCTION app_phone_reset_complete(p_challenge_id uuid, p_reset_token_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record;
BEGIN
  IF p_reset_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CODE_INVALID' USING ERRCODE = '22023'; END IF;
  SELECT ch.* INTO c FROM account_phone_challenges ch JOIN users u ON u.id = ch.user_id
   WHERE ch.id = p_challenge_id AND ch.purpose = 'RESET' AND ch.consumed_at IS NULL AND ch.expires_at > now()
     AND u.phone = ch.phone AND u.phone_verified_at IS NOT NULL AND u.status = 'active'
     AND (u.phone_changed_at IS NULL OR u.phone_changed_at < now() - interval '72 hours')
   FOR UPDATE OF ch;
  IF NOT FOUND THEN RAISE EXCEPTION 'CODE_INVALID' USING ERRCODE = '22023'; END IF;
  UPDATE account_phone_challenges SET consumed_at = now() WHERE id = c.id;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = c.user_id AND used_at IS NULL;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (c.user_id, p_reset_token_hash, now() + interval '10 minutes');
  INSERT INTO account_security_events (user_id, event, phone_last4) VALUES (c.user_id, 'SMS_RESET_VERIFIED', right(c.phone, 4));
END $$;
REVOKE ALL ON FUNCTION app_phone_reset_complete(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_phone_reset_complete(uuid, text) TO app_runtime;

-- ---------------------------------------------------------------- invitations: only a verified phone matches
CREATE OR REPLACE FUNCTION app_family_invitation_allows_self_insert(
  p_invitation_id uuid, p_organization_id uuid, p_care_recipient_id uuid,
  p_relationship_type text, p_can_view_photos boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
        OR (i.phone IS NOT NULL AND u.phone IS NOT NULL AND u.phone_verified_at IS NOT NULL AND i.phone = u.phone)
      )
  );
$$;
REVOKE ALL ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_invitation_allows_self_insert(uuid, uuid, uuid, text, boolean) TO app_runtime;

-- ETNARA central never reaches these tables.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_superadmin') THEN
    EXECUTE 'DROP POLICY IF EXISTS platform_phi_deny ON account_phone_challenges';
    EXECUTE 'CREATE POLICY platform_phi_deny ON account_phone_challenges AS RESTRICTIVE FOR ALL USING (NOT app_is_superadmin())';
    EXECUTE 'DROP POLICY IF EXISTS platform_phi_deny ON account_security_events';
    EXECUTE 'CREATE POLICY platform_phi_deny ON account_security_events AS RESTRICTIVE FOR ALL USING (NOT app_is_superadmin())';
  END IF;
END $$;

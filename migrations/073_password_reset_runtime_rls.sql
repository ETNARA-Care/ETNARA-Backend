-- Migration 073: apply password-reset RLS policies to databases where
-- migration 072 already ran before its policy hardening was added.

DROP POLICY IF EXISTS password_reset_tokens_user_manage ON password_reset_tokens;
DROP POLICY IF EXISTS password_reset_tokens_hash_lookup ON password_reset_tokens;
DROP POLICY IF EXISTS password_reset_tokens_hash_claim ON password_reset_tokens;

CREATE POLICY password_reset_tokens_user_manage ON password_reset_tokens
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY password_reset_tokens_hash_lookup ON password_reset_tokens
    FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), ''));

CREATE POLICY password_reset_tokens_hash_claim ON password_reset_tokens
    FOR UPDATE
    USING (token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), ''))
    WITH CHECK (token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), ''));

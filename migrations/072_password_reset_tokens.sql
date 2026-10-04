-- Migration 072: secure, expiring, single-use password reset tokens.
-- Raw reset tokens are never persisted; only SHA-256 hashes are stored.

CREATE TABLE password_reset_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_tokens_user_active
    ON password_reset_tokens (user_id, expires_at DESC)
    WHERE used_at IS NULL;

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

-- A user-scoped transaction may issue and invalidate only that user's
-- reset tokens. This is used after the backend has resolved the normalized
-- account identifier through the existing login lookup context.
CREATE POLICY password_reset_tokens_user_manage ON password_reset_tokens
    FOR ALL
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    );

-- Before an identity is known, a reset credential may resolve only the
-- exact SHA-256 token hash supplied by the backend. The raw token is never
-- stored in PostgreSQL.
CREATE POLICY password_reset_tokens_hash_lookup ON password_reset_tokens
    FOR SELECT
    USING (
        token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), '')
    );

-- Token claiming is also limited to the exact hashed reset credential.
-- The application must additionally require used_at IS NULL and
-- expires_at > now() in the UPDATE that claims the token.
CREATE POLICY password_reset_tokens_hash_claim ON password_reset_tokens
    FOR UPDATE
    USING (
        token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), '')
    )
    WITH CHECK (
        token_hash = NULLIF(current_setting('app.lookup_password_reset_hash', true), '')
    );

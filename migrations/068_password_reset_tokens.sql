-- Migration 068: secure, expiring, single-use password reset tokens.
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

-- Reset-token access is intentionally performed only through narrowly scoped
-- authentication lookup contexts / database helpers, never tenant browsing.
REVOKE ALL ON password_reset_tokens FROM PUBLIC;

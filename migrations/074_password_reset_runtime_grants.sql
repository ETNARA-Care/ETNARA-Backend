-- Migration 074: restore application-role access for password reset tokens.
-- Migration 072 originally revoked PUBLIC privileges; existing databases may
-- retain that revoke even though the source migration was later hardened.
-- RLS policies remain the authorization boundary for every row operation.

GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO PUBLIC;

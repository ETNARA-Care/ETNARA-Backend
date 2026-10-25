-- Rollback of migration 120 (family invitation e-mail).
-- Safe at any time: the column only records when an e-mail was accepted by the
-- provider; invitations, tokens and family access do not depend on it.
-- Deploy the previous backend first (it does not read the column), then run this.

BEGIN;
ALTER TABLE access_invitations DROP COLUMN IF EXISTS email_sent_at;
DELETE FROM schema_migrations WHERE filename = '120_family_invitation_email.sql';
COMMIT;

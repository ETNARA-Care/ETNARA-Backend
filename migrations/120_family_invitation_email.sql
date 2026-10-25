-- Migration 120: family invitations are sent by e-mail (Resend).
--
-- One additive, nullable column: when the e-mail provider last ACCEPTED an
-- invitation e-mail. It lets the agency see «Correo enviado …» and lets the API
-- refuse a re-send within one minute (no mail bombing).
--
-- No data is modified. No policy, grant, function or permission changes:
-- app_runtime already has table-level SELECT/INSERT/UPDATE on access_invitations
-- and the existing manager-only RLS still decides who can write a row.
-- Rollback: ops/120_family_invitation_email.rollback.sql (drops the column).

ALTER TABLE access_invitations
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;

COMMENT ON COLUMN access_invitations.email_sent_at IS
  'Last time the e-mail provider accepted this invitation e-mail (family invitations). NULL = never sent by e-mail.';

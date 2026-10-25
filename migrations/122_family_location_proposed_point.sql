-- Migration 122: a relative can propose the exact point (PIN) of the service.
--
-- Gate 6 lets an active relative ask for a correction of the address; the agency
-- approves or rejects it. Until now the request could only carry written fields.
-- This adds two nullable columns for a proposed map point:
--   * both or neither (pair), and only inside Puerto Rico (same bounds as the
--     agency's GPS confirmation, confirmGpsSchema);
--   * the relative may INSERT them (column grant), never UPDATE them;
--   * approving applies the point to the official address UNCONFIRMED: the
--     existing trigger (105) clears gps_confirmed_at, so caregivers do not
--     navigate to it until a manager confirms it explicitly.
--
-- No data is modified. No policy changes: the existing INSERT/SELECT/UPDATE
-- policies (100) still decide who writes and reads each row.
-- Rollback: ops/122_family_location_proposed_point.rollback.sql

ALTER TABLE care_recipient_location_change_requests
  ADD COLUMN IF NOT EXISTS proposed_latitude  numeric(9,6),
  ADD COLUMN IF NOT EXISTS proposed_longitude numeric(9,6);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'location_change_requests_point_pair') THEN
    ALTER TABLE care_recipient_location_change_requests
      ADD CONSTRAINT location_change_requests_point_pair
      CHECK ((proposed_latitude IS NULL) = (proposed_longitude IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'location_change_requests_point_in_pr') THEN
    ALTER TABLE care_recipient_location_change_requests
      ADD CONSTRAINT location_change_requests_point_in_pr
      CHECK (proposed_latitude IS NULL
             OR (proposed_latitude BETWEEN 17.5 AND 18.7 AND proposed_longitude BETWEEN -68.0 AND -65.1));
  END IF;
END $$;

GRANT INSERT (proposed_latitude, proposed_longitude) ON care_recipient_location_change_requests TO app_runtime;

COMMENT ON COLUMN care_recipient_location_change_requests.proposed_latitude IS
  'Point proposed by the relative (Puerto Rico). Applied unconfirmed on approval; a manager confirms it.';

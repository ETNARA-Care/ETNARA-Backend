-- Rollback of migration 122 (proposed map point in family location requests).
-- Deploy the previous backend first (it does not read these columns), then run this.
-- Drops only the proposed point; requests, addresses and history stay.

BEGIN;
REVOKE INSERT (proposed_latitude, proposed_longitude) ON care_recipient_location_change_requests FROM app_runtime;
ALTER TABLE care_recipient_location_change_requests
  DROP CONSTRAINT IF EXISTS location_change_requests_point_in_pr,
  DROP CONSTRAINT IF EXISTS location_change_requests_point_pair,
  DROP COLUMN IF EXISTS proposed_longitude,
  DROP COLUMN IF EXISTS proposed_latitude;
DELETE FROM schema_migrations WHERE filename = '122_family_location_proposed_point.sql';
COMMIT;

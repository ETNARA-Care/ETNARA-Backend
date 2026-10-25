-- READ-ONLY assessment before rolling back migration 122. Changes nothing.
-- Run it as the owner, inside a read-only transaction:
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f ops/122_family_location_rollback_assessment.sql
-- Output is counts only: it never prints addresses, coordinates, names or ids.
--
-- What a rollback would lose: ONLY the PIN proposed by relatives in correction
-- requests (proposed_latitude/longitude). Official addresses, confirmed points,
-- shifts, history and the requests themselves stay.
--   * pending_with_pin: the agency would no longer see the proposed PIN.
--   * pending_pin_only: these requests would be left without content; the agency
--     should reject them with a note, or the relative should send them again.
--   * resolved_with_pin: historical record of a proposal already decided; an
--     APPROVED one is already applied to the address (unconfirmed or confirmed).

BEGIN TRANSACTION READ ONLY;

SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '122_family_location_proposed_point.sql') AS migration_122_applied,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'care_recipient_location_change_requests' AND column_name = 'proposed_latitude') AS columns_present;

SELECT
  count(*) FILTER (WHERE status = 'PENDING' AND proposed_latitude IS NOT NULL) AS pending_with_pin,
  count(*) FILTER (WHERE status = 'PENDING' AND proposed_latitude IS NOT NULL
                   AND proposed_address_line IS NULL AND proposed_municipality IS NULL AND proposed_postal_code IS NULL
                   AND proposed_access_notes IS NULL) AS pending_pin_only,
  count(*) FILTER (WHERE status <> 'PENDING' AND proposed_latitude IS NOT NULL) AS resolved_with_pin,
  count(DISTINCT organization_id) FILTER (WHERE proposed_latitude IS NOT NULL) AS agencies_affected
FROM care_recipient_location_change_requests;

ROLLBACK;

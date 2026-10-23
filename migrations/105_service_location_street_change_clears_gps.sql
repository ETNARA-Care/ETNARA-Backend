-- 105_service_location_street_change_clears_gps.sql
--
-- Gate 6 close. 103 kept the GPS confirmation when only the written address
-- changed. But when the street, the municipality or the establishment changes
-- (a family correction approved by the agency, or the agency's own edit), the
-- confirmed point most likely belongs to the old place: a caregiver would
-- navigate to the previous house with «Punto exacto confirmado».
--
-- Rule now:
--   * address_line / municipality / establishment_id changed -> written-address
--     verification AND GPS confirmation are cleared (the marker itself is kept
--     as an unconfirmed reference so the admin can re-confirm or move it).
--   * postal_code only -> written-address verification cleared, GPS kept.
--   * access_notes -> nothing cleared.
--   * marker moved -> GPS confirmation cleared (unchanged from 103).
-- Existing rows are not touched.

CREATE OR REPLACE FUNCTION app_care_recipient_location_reverify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Written address changed -> the written address must be verified again.
  IF (NEW.address_line, NEW.municipality, NEW.postal_code, NEW.establishment_id)
     IS DISTINCT FROM (OLD.address_line, OLD.municipality, OLD.postal_code, OLD.establishment_id)
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
    NEW.verified_at := NULL;
    NEW.verified_by_user_id := NULL;
  END IF;
  -- Different place (street, town or establishment) or marker moved/removed ->
  -- the exact point must be confirmed again.
  IF ((NEW.address_line, NEW.municipality, NEW.establishment_id)
        IS DISTINCT FROM (OLD.address_line, OLD.municipality, OLD.establishment_id)
      OR (NEW.latitude, NEW.longitude) IS DISTINCT FROM (OLD.latitude, OLD.longitude))
     AND NEW.gps_confirmed_at IS NOT DISTINCT FROM OLD.gps_confirmed_at THEN
    NEW.gps_confirmed_at := NULL;
    NEW.gps_confirmed_by_user_id := NULL;
  END IF;
  IF NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'CARE_RECIPIENT_LOCATION_OWNER_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

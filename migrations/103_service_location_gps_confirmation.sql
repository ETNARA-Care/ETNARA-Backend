-- Migration 103: Gate 6 fixes -- separate "address verified" from "GPS confirmed".
--
-- Found in manual iPhone testing: an address showed «Verificada» while having
-- no map marker, and navigation could end at an approximate street point.
--   * verified_at       = the agency checked the WRITTEN address (unchanged meaning).
--   * gps_confirmed_at  = the agency explicitly confirmed the exact map point.
-- A GPS confirmation needs coordinates, records who/when, and is cleared when
-- the marker moves. Editing the written address clears only verified_at;
-- moving the marker clears only gps_confirmed_at. Existing rows keep their
-- verification; none is GPS-confirmed until an administrator confirms it.
-- Only managers write (084 policies, unchanged); history via the 100 trigger.

ALTER TABLE care_recipient_locations
  ADD COLUMN IF NOT EXISTS gps_confirmed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS gps_confirmed_by_user_id uuid NULL REFERENCES users(id);
ALTER TABLE care_recipient_locations
  ADD CONSTRAINT care_recipient_locations_gps_confirmed_pair
    CHECK ((gps_confirmed_at IS NULL) = (gps_confirmed_by_user_id IS NULL)),
  ADD CONSTRAINT care_recipient_locations_gps_needs_coordinates
    CHECK (gps_confirmed_at IS NULL OR (latitude IS NOT NULL AND longitude IS NOT NULL));

GRANT UPDATE (gps_confirmed_at, gps_confirmed_by_user_id) ON care_recipient_locations TO app_runtime;

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
  -- Marker moved or removed -> the exact point must be confirmed again.
  IF (NEW.latitude, NEW.longitude) IS DISTINCT FROM (OLD.latitude, OLD.longitude)
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

-- History: two new event kinds and the GPS state in each snapshot.
ALTER TABLE care_recipient_location_events DROP CONSTRAINT IF EXISTS care_recipient_location_events_event_type_check;
ALTER TABLE care_recipient_location_events ADD CONSTRAINT care_recipient_location_events_event_type_check
  CHECK (event_type IN ('CREATED','UPDATED','VERIFIED','PRIMARY_SET','ARCHIVED','RESTORED','GPS_CONFIRMED','GPS_CHANGED'));

CREATE OR REPLACE FUNCTION app_care_recipient_location_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  kind text;
  snap jsonb := jsonb_build_object(
    'label', NEW.label, 'address_line', NEW.address_line, 'municipality', NEW.municipality,
    'postal_code', NEW.postal_code, 'access_notes', NEW.access_notes, 'latitude', NEW.latitude,
    'longitude', NEW.longitude, 'establishment_id', NEW.establishment_id, 'is_primary', NEW.is_primary,
    'verified', NEW.verified_at IS NOT NULL, 'gps_confirmed', NEW.gps_confirmed_at IS NOT NULL,
    'archived', NEW.archived_at IS NOT NULL);
  prev jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'CREATED';
  ELSE
    prev := jsonb_build_object(
      'label', OLD.label, 'address_line', OLD.address_line, 'municipality', OLD.municipality,
      'postal_code', OLD.postal_code, 'access_notes', OLD.access_notes, 'latitude', OLD.latitude,
      'longitude', OLD.longitude, 'establishment_id', OLD.establishment_id, 'is_primary', OLD.is_primary,
      'verified', OLD.verified_at IS NOT NULL, 'gps_confirmed', OLD.gps_confirmed_at IS NOT NULL,
      'archived', OLD.archived_at IS NOT NULL);
    IF prev = snap THEN RETURN NEW; END IF;
    kind := CASE
      WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'ARCHIVED'
      WHEN NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL THEN 'RESTORED'
      WHEN NEW.gps_confirmed_at IS NOT NULL AND OLD.gps_confirmed_at IS DISTINCT FROM NEW.gps_confirmed_at THEN 'GPS_CONFIRMED'
      WHEN (NEW.latitude, NEW.longitude) IS DISTINCT FROM (OLD.latitude, OLD.longitude)
           AND prev - '{latitude,longitude,gps_confirmed}'::text[] = snap - '{latitude,longitude,gps_confirmed}'::text[] THEN 'GPS_CHANGED'
      WHEN NEW.is_primary AND NOT OLD.is_primary AND prev - 'is_primary' = snap - 'is_primary' THEN 'PRIMARY_SET'
      WHEN NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL AND prev - 'verified' = snap - 'verified' THEN 'VERIFIED'
      ELSE 'UPDATED' END;
  END IF;
  INSERT INTO public.care_recipient_location_events
    (organization_id, location_id, care_recipient_id, event_type, actor_user_id, previous, current)
  VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id, kind,
          NULLIF(current_setting('app.current_user_id', true), '')::uuid, prev, snap);
  RETURN NEW;
END;
$$;

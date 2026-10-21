-- Phase 12.1: care recipient address and directions for home visits.
--
-- The address lives in its own table instead of new care_recipients columns,
-- so PostgreSQL enforces who can read it independently of the recipient row:
--   - organization managers (ORGANIZATION_ADMIN, SUPERVISOR): read and write
--   - a worker: read only while app_worker_has_recipient_assignment() is true,
--     i.e. an assigned, not-yet-ended shift or a still-open visit (076 rules)
--   - family members: no policy, so no access, even though they can read the
--     recipient row itself
--   - platform administrators: denied by the platform_phi_deny pattern (078)
-- Additive only. No existing table, policy or function is changed.

CREATE TABLE IF NOT EXISTS care_recipient_locations (
    care_recipient_id   uuid PRIMARY KEY REFERENCES care_recipients(id),
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    address_line        text NULL CHECK (address_line IS NULL OR char_length(address_line) <= 200),
    municipality        text NULL CHECK (municipality IS NULL OR char_length(municipality) <= 60),
    access_notes        text NULL CHECK (access_notes IS NULL OR char_length(access_notes) <= 500),
    latitude            numeric(9, 6) NULL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    longitude           numeric(9, 6) NULL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by_user_id  uuid NULL REFERENCES users(id),
    CONSTRAINT care_recipient_locations_coordinates_pair
        CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX IF NOT EXISTS care_recipient_locations_org_idx
    ON care_recipient_locations (organization_id);

-- The location must belong to the same organization as its recipient.
CREATE OR REPLACE FUNCTION app_care_recipient_location_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.care_recipients cr
        WHERE cr.id = NEW.care_recipient_id AND cr.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'CARE_RECIPIENT_LOCATION_ORG_MISMATCH' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_care_recipient_location_same_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS care_recipient_locations_same_org ON care_recipient_locations;
CREATE TRIGGER care_recipient_locations_same_org
    BEFORE INSERT OR UPDATE ON care_recipient_locations
    FOR EACH ROW EXECUTE FUNCTION app_care_recipient_location_same_org();

ALTER TABLE care_recipient_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS care_recipient_locations_read ON care_recipient_locations;
CREATE POLICY care_recipient_locations_read ON care_recipient_locations
    FOR SELECT
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND (app_is_org_manager() OR app_worker_has_recipient_assignment(care_recipient_id))
    );

DROP POLICY IF EXISTS care_recipient_locations_manager_insert ON care_recipient_locations;
CREATE POLICY care_recipient_locations_manager_insert ON care_recipient_locations
    FOR INSERT
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
    );

DROP POLICY IF EXISTS care_recipient_locations_manager_update ON care_recipient_locations;
CREATE POLICY care_recipient_locations_manager_update ON care_recipient_locations
    FOR UPDATE
    USING (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
    )
    WITH CHECK (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND app_is_org_manager()
    );

DROP POLICY IF EXISTS platform_phi_deny ON care_recipient_locations;
CREATE POLICY platform_phi_deny ON care_recipient_locations
    AS RESTRICTIVE FOR ALL TO app_runtime
    USING (NOT app_is_superadmin())
    WITH CHECK (NOT app_is_superadmin());

-- No DELETE grant: clearing an address is an UPDATE to NULL, keeping history of who changed it.
GRANT SELECT, INSERT, UPDATE ON care_recipient_locations TO app_runtime;

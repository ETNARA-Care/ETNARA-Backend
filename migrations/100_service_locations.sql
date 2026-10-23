-- Migration 100: Gate 6 -- official service location of the person receiving care.
--
-- Builds on care_recipient_locations (084) instead of a parallel module:
--   * several addresses per person (one primary, alternates, archived ones kept),
--     ZIP code, label, verification, or a pointer to the agency establishment
--     (residential homes reuse the establishment address, never copied);
--   * append-only change history and a log of worker address access;
--   * shifts.service_location_id: the confirmed address of each shift, changed
--     only by an explicit, audited action;
--   * workers read ONLY the address of a shift they are currently assigned to
--     (not the person's other addresses); access ends with the assignment (076);
--   * family members read the primary address only when the agency enabled
--     can_view_service_location for them (off by default) and may file
--     correction requests the agency approves or rejects.
-- ETNARA central / Tower: platform_phi_deny on every new table (078 pattern).

-- 1. Several addresses per person -----------------------------------------
ALTER TABLE care_recipient_locations ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE care_recipient_locations DROP CONSTRAINT IF EXISTS care_recipient_locations_pkey;
ALTER TABLE care_recipient_locations ADD CONSTRAINT care_recipient_locations_pkey PRIMARY KEY (id);
ALTER TABLE care_recipient_locations ADD CONSTRAINT care_recipient_locations_id_org UNIQUE (id, organization_id);
ALTER TABLE care_recipient_locations
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'Principal'
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
  ADD COLUMN IF NOT EXISTS postal_code text NULL CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS establishment_id uuid NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid NULL REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE care_recipient_locations
  ADD CONSTRAINT care_recipient_locations_establishment_same_org
    FOREIGN KEY (establishment_id, organization_id) REFERENCES locations (id, organization_id),
  -- An establishment address is referenced, never duplicated.
  ADD CONSTRAINT care_recipient_locations_establishment_no_copy
    CHECK (establishment_id IS NULL OR (address_line IS NULL AND municipality IS NULL AND postal_code IS NULL)),
  ADD CONSTRAINT care_recipient_locations_archived_not_primary
    CHECK (archived_at IS NULL OR NOT is_primary),
  ADD CONSTRAINT care_recipient_locations_verified_pair
    CHECK ((verified_at IS NULL) = (verified_by_user_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS care_recipient_locations_one_primary
  ON care_recipient_locations (care_recipient_id) WHERE is_primary AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS care_recipient_locations_recipient_idx ON care_recipient_locations (care_recipient_id);

-- Editing the address itself clears its verification (it must be re-checked).
CREATE OR REPLACE FUNCTION app_care_recipient_location_reverify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.address_line, NEW.municipality, NEW.postal_code, NEW.latitude, NEW.longitude, NEW.establishment_id)
     IS DISTINCT FROM (OLD.address_line, OLD.municipality, OLD.postal_code, OLD.latitude, OLD.longitude, OLD.establishment_id)
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
    NEW.verified_at := NULL;
    NEW.verified_by_user_id := NULL;
  END IF;
  IF NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'CARE_RECIPIENT_LOCATION_OWNER_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS care_recipient_locations_reverify ON care_recipient_locations;
CREATE TRIGGER care_recipient_locations_reverify
  BEFORE UPDATE ON care_recipient_locations
  FOR EACH ROW EXECUTE FUNCTION app_care_recipient_location_reverify();

-- 2. Address of each shift --------------------------------------------------
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS service_location_id uuid NULL;
ALTER TABLE shifts ADD CONSTRAINT shifts_service_location_same_org
  FOREIGN KEY (service_location_id, organization_id) REFERENCES care_recipient_locations (id, organization_id);
CREATE INDEX IF NOT EXISTS shifts_service_location_idx ON shifts (service_location_id) WHERE service_location_id IS NOT NULL;
-- shifts uses column-level UPDATE grants; RLS (managers) still decides which rows.
GRANT UPDATE (service_location_id) ON shifts TO app_runtime;

-- The address must be one of the shift's own person receiving care.
CREATE OR REPLACE FUNCTION app_shift_service_location_matches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.service_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.care_recipient_locations l
    WHERE l.id = NEW.service_location_id AND l.organization_id = NEW.organization_id
      AND l.care_recipient_id = NEW.care_recipient_id
  ) THEN
    RAISE EXCEPTION 'SHIFT_SERVICE_LOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_service_location_matches() FROM PUBLIC;
DROP TRIGGER IF EXISTS shifts_service_location_matches ON shifts;
CREATE TRIGGER shifts_service_location_matches
  BEFORE INSERT OR UPDATE OF service_location_id, care_recipient_id ON shifts
  FOR EACH ROW EXECUTE FUNCTION app_shift_service_location_matches();

-- Every change of a shift's address after creation is audited.
CREATE TABLE IF NOT EXISTS shift_service_location_changes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  shift_id               uuid NOT NULL,
  previous_location_id   uuid NULL,
  new_location_id        uuid NULL,
  changed_by_user_id     uuid NULL REFERENCES users(id),
  changed_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);
CREATE OR REPLACE FUNCTION app_shift_service_location_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.shift_service_location_changes (organization_id, shift_id, previous_location_id, new_location_id, changed_by_user_id)
  VALUES (NEW.organization_id, NEW.id, OLD.service_location_id, NEW.service_location_id,
          NULLIF(current_setting('app.current_user_id', true), '')::uuid);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_shift_service_location_audit() FROM PUBLIC;
DROP TRIGGER IF EXISTS shifts_service_location_audit ON shifts;
CREATE TRIGGER shifts_service_location_audit
  AFTER UPDATE OF service_location_id ON shifts
  FOR EACH ROW WHEN (NEW.service_location_id IS DISTINCT FROM OLD.service_location_id)
  EXECUTE FUNCTION app_shift_service_location_audit();
ALTER TABLE shift_service_location_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_service_location_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_service_location_changes_manager_read ON shift_service_location_changes
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON shift_service_location_changes
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON shift_service_location_changes TO app_runtime;

-- 3. Who reads which address -----------------------------------------------
-- A worker reads an address only through a shift it is assigned to right now:
-- the shift's confirmed address, or the primary one when the shift has none.
CREATE OR REPLACE FUNCTION app_worker_can_read_service_location(
  p_location_id uuid, p_recipient_id uuid, p_is_primary boolean, p_archived_at timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND s.care_recipient_id = p_recipient_id
      AND (s.service_location_id = p_location_id
           OR (s.service_location_id IS NULL AND p_is_primary AND p_archived_at IS NULL))
      AND public.app_worker_has_shift_assignment(s.id)
  );
$$;
REVOKE ALL ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_can_read_service_location(uuid, uuid, boolean, timestamptz) TO app_runtime;

-- Family: off by default; only the agency (managers) may switch it.
ALTER TABLE family_relationships ADD COLUMN IF NOT EXISTS can_view_service_location boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION app_family_location_permission_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.can_view_service_location IS DISTINCT FROM COALESCE(OLD.can_view_service_location, false)
     AND current_user = 'app_runtime' AND NOT app_is_org_manager() THEN
    RAISE EXCEPTION 'FAMILY_LOCATION_PERMISSION_MANAGER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS family_relationships_location_permission_guard ON family_relationships;
CREATE TRIGGER family_relationships_location_permission_guard
  BEFORE INSERT OR UPDATE ON family_relationships
  FOR EACH ROW EXECUTE FUNCTION app_family_location_permission_guard();

CREATE OR REPLACE FUNCTION app_family_can_read_service_location(p_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_relationships fr
    WHERE fr.care_recipient_id = p_recipient_id
      AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND fr.status = 'active'
      AND fr.can_view_service_location
      AND public.app_user_authorized_for_recipient(fr.user_id, fr.organization_id, fr.care_recipient_id)
  );
$$;
REVOKE ALL ON FUNCTION app_family_can_read_service_location(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_can_read_service_location(uuid) TO app_runtime;

DROP POLICY IF EXISTS care_recipient_locations_read ON care_recipient_locations;
CREATE POLICY care_recipient_locations_read ON care_recipient_locations
  FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND (
      app_is_org_manager()
      OR app_worker_can_read_service_location(id, care_recipient_id, is_primary, archived_at)
      OR (is_primary AND archived_at IS NULL AND app_family_can_read_service_location(care_recipient_id))
    )
  );
ALTER TABLE care_recipient_locations FORCE ROW LEVEL SECURITY;

-- 4. Change history (append-only, written only by the trigger) -------------
CREATE TABLE IF NOT EXISTS care_recipient_location_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  location_id       uuid NOT NULL,
  care_recipient_id uuid NOT NULL,
  event_type        text NOT NULL CHECK (event_type IN ('CREATED','UPDATED','VERIFIED','PRIMARY_SET','ARCHIVED','RESTORED')),
  actor_user_id     uuid NULL REFERENCES users(id),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  previous          jsonb NULL,
  current           jsonb NOT NULL,
  FOREIGN KEY (location_id, organization_id) REFERENCES care_recipient_locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS care_recipient_location_events_recipient_idx
  ON care_recipient_location_events (care_recipient_id, occurred_at DESC);

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
    'verified', NEW.verified_at IS NOT NULL, 'archived', NEW.archived_at IS NOT NULL);
  prev jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'CREATED';
  ELSE
    prev := jsonb_build_object(
      'label', OLD.label, 'address_line', OLD.address_line, 'municipality', OLD.municipality,
      'postal_code', OLD.postal_code, 'access_notes', OLD.access_notes, 'latitude', OLD.latitude,
      'longitude', OLD.longitude, 'establishment_id', OLD.establishment_id, 'is_primary', OLD.is_primary,
      'verified', OLD.verified_at IS NOT NULL, 'archived', OLD.archived_at IS NOT NULL);
    IF prev = snap THEN RETURN NEW; END IF;
    kind := CASE
      WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'ARCHIVED'
      WHEN NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL THEN 'RESTORED'
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
REVOKE ALL ON FUNCTION app_care_recipient_location_history() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_recipient_locations_history ON care_recipient_locations;
CREATE TRIGGER care_recipient_locations_history
  AFTER INSERT OR UPDATE ON care_recipient_locations
  FOR EACH ROW EXECUTE FUNCTION app_care_recipient_location_history();

-- Existing addresses get a starting point in their history.
INSERT INTO care_recipient_location_events (organization_id, location_id, care_recipient_id, event_type, actor_user_id, current)
SELECT l.organization_id, l.id, l.care_recipient_id, 'CREATED', l.updated_by_user_id,
       jsonb_build_object('label', l.label, 'address_line', l.address_line, 'municipality', l.municipality,
         'postal_code', l.postal_code, 'access_notes', l.access_notes, 'latitude', l.latitude, 'longitude', l.longitude,
         'establishment_id', l.establishment_id, 'is_primary', l.is_primary, 'verified', false, 'archived', false)
FROM care_recipient_locations l
WHERE NOT EXISTS (SELECT 1 FROM care_recipient_location_events e WHERE e.location_id = l.id);

ALTER TABLE care_recipient_location_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recipient_location_events FORCE ROW LEVEL SECURITY;
CREATE POLICY care_recipient_location_events_manager_read ON care_recipient_location_events
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON care_recipient_location_events
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON care_recipient_location_events TO app_runtime;

-- 5. Sensitive access log: which worker opened which address, for which shift
CREATE TABLE IF NOT EXISTS care_recipient_location_access_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  location_id      uuid NOT NULL,
  shift_id         uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  accessed_on      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Puerto_Rico')::date,
  first_access_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES care_recipient_locations (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  UNIQUE (user_id, location_id, shift_id, accessed_on)
);
ALTER TABLE care_recipient_location_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recipient_location_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY location_access_log_self_insert ON care_recipient_location_access_log
  FOR INSERT TO app_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND app_worker_has_shift_assignment(shift_id)
  );
CREATE POLICY location_access_log_manager_read ON care_recipient_location_access_log
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY platform_phi_deny ON care_recipient_location_access_log
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON care_recipient_location_access_log TO app_runtime;
GRANT INSERT (organization_id, location_id, shift_id, user_id) ON care_recipient_location_access_log TO app_runtime;

-- 6. Family correction requests ---------------------------------------------
CREATE TABLE IF NOT EXISTS care_recipient_location_change_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  care_recipient_id       uuid NOT NULL,
  family_relationship_id  uuid NOT NULL REFERENCES family_relationships(id),
  requested_by_user_id    uuid NOT NULL REFERENCES users(id),
  proposed_address_line   text NULL CHECK (proposed_address_line IS NULL OR char_length(proposed_address_line) <= 200),
  proposed_municipality   text NULL CHECK (proposed_municipality IS NULL OR char_length(proposed_municipality) <= 60),
  proposed_postal_code    text NULL CHECK (proposed_postal_code IS NULL OR proposed_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  proposed_access_notes   text NULL CHECK (proposed_access_notes IS NULL OR char_length(proposed_access_notes) <= 500),
  message                 text NULL CHECK (message IS NULL OR char_length(message) <= 500),
  status                  text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  resolution_note         text NULL CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 300),
  resolved_by_user_id     uuid NULL REFERENCES users(id),
  resolved_at             timestamptz NULL,
  applied_location_id     uuid NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id),
  FOREIGN KEY (applied_location_id, organization_id) REFERENCES care_recipient_locations (id, organization_id),
  CHECK (proposed_address_line IS NOT NULL OR proposed_municipality IS NOT NULL
         OR proposed_postal_code IS NOT NULL OR proposed_access_notes IS NOT NULL OR message IS NOT NULL),
  CHECK ((status = 'PENDING') = (resolved_at IS NULL)),
  CHECK ((status = 'PENDING') = (resolved_by_user_id IS NULL))
);
-- One open request per relative and person.
CREATE UNIQUE INDEX IF NOT EXISTS location_change_requests_one_pending
  ON care_recipient_location_change_requests (family_relationship_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS location_change_requests_recipient_idx
  ON care_recipient_location_change_requests (care_recipient_id, created_at DESC);

CREATE OR REPLACE FUNCTION app_family_owns_relationship(p_relationship_id uuid, p_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_relationships fr
    WHERE fr.id = p_relationship_id AND fr.care_recipient_id = p_recipient_id
      AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND fr.status = 'active'
      AND public.app_user_authorized_for_recipient(fr.user_id, fr.organization_id, fr.care_recipient_id)
  );
$$;
REVOKE ALL ON FUNCTION app_family_owns_relationship(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_family_owns_relationship(uuid, uuid) TO app_runtime;

-- Requests move only PENDING -> APPROVED/REJECTED; the proposal itself is immutable.
CREATE OR REPLACE FUNCTION app_location_change_request_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'LOCATION_CHANGE_REQUEST_ALREADY_RESOLVED' USING ERRCODE = '23514';
  END IF;
  IF (NEW.organization_id, NEW.care_recipient_id, NEW.family_relationship_id, NEW.requested_by_user_id,
      NEW.proposed_address_line, NEW.proposed_municipality, NEW.proposed_postal_code, NEW.proposed_access_notes,
      NEW.message, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.care_recipient_id, OLD.family_relationship_id, OLD.requested_by_user_id,
      OLD.proposed_address_line, OLD.proposed_municipality, OLD.proposed_postal_code, OLD.proposed_access_notes,
      OLD.message, OLD.created_at) THEN
    RAISE EXCEPTION 'LOCATION_CHANGE_REQUEST_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS location_change_request_transition ON care_recipient_location_change_requests;
CREATE TRIGGER location_change_request_transition
  BEFORE UPDATE ON care_recipient_location_change_requests
  FOR EACH ROW EXECUTE FUNCTION app_location_change_request_transition();

ALTER TABLE care_recipient_location_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recipient_location_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY location_change_requests_family_insert ON care_recipient_location_change_requests
  FOR INSERT TO app_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND requested_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND status = 'PENDING'
    AND app_family_owns_relationship(family_relationship_id, care_recipient_id)
  );
CREATE POLICY location_change_requests_family_read ON care_recipient_location_change_requests
  FOR SELECT TO app_runtime
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND requested_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
CREATE POLICY location_change_requests_manager_read ON care_recipient_location_change_requests
  FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
CREATE POLICY location_change_requests_manager_resolve ON care_recipient_location_change_requests
  FOR UPDATE TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()
              AND resolved_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY platform_phi_deny ON care_recipient_location_change_requests
  AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT ON care_recipient_location_change_requests TO app_runtime;
GRANT INSERT (organization_id, care_recipient_id, family_relationship_id, requested_by_user_id,
              proposed_address_line, proposed_municipality, proposed_postal_code, proposed_access_notes, message)
  ON care_recipient_location_change_requests TO app_runtime;
GRANT UPDATE (status, resolution_note, resolved_by_user_id, resolved_at, applied_location_id)
  ON care_recipient_location_change_requests TO app_runtime;

-- Notifications (existing table): managers on a new request, the relative on the
-- decision. Never the address itself; idempotent like 098.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_location_request_once
  ON notifications (user_id, notification_type, related_entity_id)
  WHERE related_entity_type = 'location_change_request';

CREATE OR REPLACE FUNCTION app_location_change_request_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT om.user_id, NEW.organization_id, 'LOCATION_CHANGE_REQUESTED', 'location_change_request',
           NEW.id, NEW.care_recipient_id, 'in_app', 'sent', now()
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.organization_id = NEW.organization_id AND om.status = 'active'
      AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    ON CONFLICT DO NOTHING;
  ELSIF NEW.status IN ('APPROVED', 'REJECTED') AND OLD.status = 'PENDING' THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                      related_entity_id, care_recipient_id, channel, status, sent_at)
    VALUES (NEW.requested_by_user_id, NEW.organization_id,
            CASE NEW.status WHEN 'APPROVED' THEN 'LOCATION_CHANGE_APPROVED' ELSE 'LOCATION_CHANGE_REJECTED' END,
            'location_change_request', NEW.id, NEW.care_recipient_id, 'in_app', 'sent', now())
    ON CONFLICT DO NOTHING;
    UPDATE public.notifications SET read_at = COALESCE(read_at, now())
    WHERE related_entity_type = 'location_change_request' AND related_entity_id = NEW.id
      AND notification_type = 'LOCATION_CHANGE_REQUESTED';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_location_change_request_notify() FROM PUBLIC;
DROP TRIGGER IF EXISTS location_change_request_notify ON care_recipient_location_change_requests;
CREATE TRIGGER location_change_request_notify
  AFTER INSERT OR UPDATE ON care_recipient_location_change_requests
  FOR EACH ROW EXECUTE FUNCTION app_location_change_request_notify();

GRANT UPDATE (label, postal_code, is_primary, establishment_id, verified_at, verified_by_user_id, archived_at)
  ON care_recipient_locations TO app_runtime;

-- 7. Residential homes: the establishment address is read through the person's
-- location row (never copied). Business address only, own agency only.
CREATE OR REPLACE FUNCTION app_establishment_address(p_establishment_id uuid)
RETURNS TABLE (name text, address text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT l.name, l.address FROM public.locations l
  WHERE l.id = p_establishment_id
    AND l.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND l.archived_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app_establishment_address(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_establishment_address(uuid) TO app_runtime;

-- 8. "Your shift's address changed" notice for the assigned caregivers. A narrow
-- SECURITY DEFINER path instead of widening the notifications INSERT policy:
-- only a manager of the current agency, only that agency's shifts, no address.
CREATE OR REPLACE FUNCTION app_notify_shift_location_changed(p_shift_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  n integer;
BEGIN
  IF org IS NULL OR NOT public.app_is_org_manager() THEN
    RAISE EXCEPTION 'NOT_ORG_MANAGER' USING ERRCODE = '42501';
  END IF;
  WITH inserted AS (
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id,
                                      care_recipient_id, channel, status, sent_at)
    SELECT DISTINCT w.user_id, org, 'SHIFT_LOCATION_CHANGED', 'shift', a.shift_id, NULL::uuid, 'in_app', 'sent', now()
    FROM public.assignments a
    JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
    JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
    JOIN public.workers w ON w.id = owm.worker_id
    WHERE a.organization_id = org AND a.shift_id = ANY(p_shift_ids)
      AND a.response_status IN ('pending', 'accepted') AND w.user_id IS NOT NULL
    RETURNING 1)
  SELECT count(*)::integer INTO n FROM inserted;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION app_notify_shift_location_changed(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_shift_location_changed(uuid[]) TO app_runtime;

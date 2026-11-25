-- 171 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F1: establecimiento, unidades y habitaciones. 25-nov-2026.
--
-- Fuente oficial: «ETNARA Care · Hogares de envejecientes: plan de implementación definitivo» (D2, D3, D8; §3, §6 F1).
-- Depende de la 170 (app_org_is_residential). No modifica la tabla shifts. Nada se enciende.
--
-- Contenido:
--   1. Registros: establishment_technical_rooms (unidad + habitación técnicas, D2), establishment_general_units
--      (unidad visible "General", D8), establishment_settings (geocerca, D3), room_profiles (camas, D8).
--   2. Historiales solo de anexos: establishment_settings_events (geocerca), care_recipient_room_events
--      (ubicación y traslados de residentes), establishment_closures (cierre).
--   3. Creación idempotente por disparador al crear un establecimiento de hogar y relleno de los existentes.
--   4. Guardas en la base de datos (también contra app_runtime directo):
--        * la habitación técnica nunca tiene residentes (para cualquiera, incluido el propietario);
--        * las piezas técnicas no se editan, archivan, eliminan ni trasladan fuera del procedimiento de cierre;
--        * "General" y cualquier unidad no se archivan con habitaciones activas;
--        * una habitación no se archiva con residentes activos y no cambia de establecimiento;
--        * en hogares, la habitación de un residente pertenece a su establecimiento y está activa;
--        * en hogares, un establecimiento solo se archiva mediante el procedimiento de cierre.
--   5. Autoridad de escritura en units y rooms: solo administración (ORGANIZATION_ADMIN/SUPERVISOR) y solo en
--      hogares; sin DELETE. Ningún código de agencias ni independientes escribe en ellas: no cambian. La lectura no
--      cambia.
--   6. Procedimiento de cierre app_residential_close_establishment(): rechaza con turnos vigentes o futuros,
--      asignaciones activas o residentes activos; archiva sin borrar.
--
-- Convención de la habitación técnica: docs/RESIDENTIAL_TECHNICAL_ROOM.md. Nunca aparece en respuestas ni conteos.
-- Reversión: ops/171_residential_establishments_rooms.rollback.sql.

-- 0. Utilidades -----------------------------------------------------------------------------------------------
-- Las piezas técnicas solo se modifican dentro del procedimiento de cierre: marca local de la transacción que el
-- procedimiento (SECURITY DEFINER) enciende y apaga. app_runtime nunca cuenta como procedimiento, aunque fije la
-- marca él mismo.
CREATE OR REPLACE FUNCTION public.app_residential_in_procedure()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT current_user::text <> 'app_runtime'
     AND COALESCE(current_setting('app.residential_procedure', true), '') = 'on';
$$;
REVOKE ALL ON FUNCTION public.app_residential_in_procedure() FROM PUBLIC;
-- Las guardas se ejecutan con los privilegios de quien escribe (app_runtime incluido): necesita poder evaluarla.
GRANT EXECUTE ON FUNCTION public.app_residential_in_procedure() TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_residential_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'RESIDENTIAL_HISTORY_APPEND_ONLY' USING ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_append_only() FROM PUBLIC;

-- 1. Registros -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS establishment_technical_rooms (
  location_id     uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  unit_id         uuid NOT NULL UNIQUE,
  room_id         uuid NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (unit_id, organization_id) REFERENCES units (id, organization_id),
  FOREIGN KEY (room_id, organization_id) REFERENCES rooms (id, organization_id)
);

CREATE TABLE IF NOT EXISTS establishment_general_units (
  location_id     uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  unit_id         uuid NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (unit_id, organization_id) REFERENCES units (id, organization_id)
);

CREATE TABLE IF NOT EXISTS establishment_settings (
  location_id        uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  geofence_radius_m  integer NOT NULL DEFAULT 100 CHECK (geofence_radius_m BETWEEN 50 AND 300),
  -- Centro del perímetro: el edificio, no una persona. Las ubicaciones de quien poncha nunca se guardan (D3).
  geofence_latitude  numeric(9,6) NULL CHECK (geofence_latitude BETWEEN -90 AND 90),
  geofence_longitude numeric(9,6) NULL CHECK (geofence_longitude BETWEEN -180 AND 180),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NULL REFERENCES users (id),
  CONSTRAINT establishment_settings_center_pair CHECK ((geofence_latitude IS NULL) = (geofence_longitude IS NULL)),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);

CREATE TABLE IF NOT EXISTS room_profiles (
  room_id            uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  -- Camas registradas por la administración. Nunca se presenta como capacidad autorizada por el Departamento de
  -- la Familia; superarla solo advierte (D8).
  bed_capacity       integer NULL CHECK (bed_capacity BETWEEN 1 AND 20),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NULL REFERENCES users (id),
  FOREIGN KEY (room_id, organization_id) REFERENCES rooms (id, organization_id)
);

-- 2. Historiales solo de anexos ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS establishment_settings_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  location_id         uuid NOT NULL,
  actor_user_id       uuid NULL REFERENCES users (id),
  reason              text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  old_radius_m        integer NULL,
  new_radius_m        integer NOT NULL,
  old_latitude        numeric(9,6) NULL,
  old_longitude       numeric(9,6) NULL,
  new_latitude        numeric(9,6) NULL,
  new_longitude       numeric(9,6) NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS establishment_settings_events_location_idx ON establishment_settings_events (location_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS care_recipient_room_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  care_recipient_id uuid NOT NULL,
  from_location_id  uuid NULL,
  to_location_id    uuid NULL,
  from_room_id      uuid NULL,
  to_room_id        uuid NULL,
  actor_user_id     uuid NULL REFERENCES users (id),
  reason            text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id)
);
CREATE INDEX IF NOT EXISTS care_recipient_room_events_recipient_idx ON care_recipient_room_events (care_recipient_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS establishment_closures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  location_id        uuid NOT NULL UNIQUE,
  closed_by_user_id  uuid NULL REFERENCES users (id),
  reason             text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  rooms_archived     integer NOT NULL,
  units_archived     integer NOT NULL,
  staff_links_archived integer NOT NULL,
  closed_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);

DROP TRIGGER IF EXISTS establishment_settings_events_append_only ON establishment_settings_events;
CREATE TRIGGER establishment_settings_events_append_only BEFORE UPDATE OR DELETE ON establishment_settings_events
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();
DROP TRIGGER IF EXISTS care_recipient_room_events_append_only ON care_recipient_room_events;
CREATE TRIGGER care_recipient_room_events_append_only BEFORE UPDATE OR DELETE ON care_recipient_room_events
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();
DROP TRIGGER IF EXISTS establishment_closures_append_only ON establishment_closures;
CREATE TRIGGER establishment_closures_append_only BEFORE UPDATE OR DELETE ON establishment_closures
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();
-- Los registros técnicos y de "General" tampoco se tocan: solo los crea la función de abajo.
DROP TRIGGER IF EXISTS establishment_technical_rooms_append_only ON establishment_technical_rooms;
CREATE TRIGGER establishment_technical_rooms_append_only BEFORE UPDATE OR DELETE ON establishment_technical_rooms
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();
DROP TRIGGER IF EXISTS establishment_general_units_append_only ON establishment_general_units;
CREATE TRIGGER establishment_general_units_append_only BEFORE UPDATE OR DELETE ON establishment_general_units
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- 3. ¿Es técnica? (solo un booleano) ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_is_technical_unit(p_unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM public.establishment_technical_rooms t WHERE t.unit_id = p_unit_id); $$;
CREATE OR REPLACE FUNCTION public.app_is_technical_room(p_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM public.establishment_technical_rooms t WHERE t.room_id = p_room_id); $$;
REVOKE ALL ON FUNCTION public.app_is_technical_unit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_is_technical_room(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_technical_unit(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_is_technical_room(uuid) TO app_runtime;

-- Identificador estable con formato UUID v4 válido (versión 4, variante RFC 4122), derivado de un texto.
CREATE OR REPLACE FUNCTION public.app_residential_stable_uuid(p_seed text)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
          || substr('89ab', (get_byte(decode(substr(h, 17, 2), 'hex'), 0) % 4) + 1, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  FROM (SELECT md5(p_seed) AS h) x;
$$;
REVOKE ALL ON FUNCTION public.app_residential_stable_uuid(text) FROM PUBLIC;

-- 4. Creación idempotente -----------------------------------------------------------------------------------------
-- Nombre centinela de las piezas técnicas: si apareciera en una respuesta, las pruebas de CI fallan.
CREATE OR REPLACE FUNCTION public.app_residential_ensure_establishment(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid;
  v_archived timestamptz;
  v_created timestamptz;
  v_unit uuid;
  v_room uuid;
BEGIN
  SELECT l.organization_id, l.archived_at, l.created_at INTO v_org, v_archived, v_created FROM public.locations l WHERE l.id = p_location_id;
  IF v_org IS NULL OR v_archived IS NOT NULL OR NOT public.app_org_is_residential(v_org) THEN
    RETURN; -- solo establecimientos activos de hogares
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('residential-establishment:' || p_location_id::text));

  IF NOT EXISTS (SELECT 1 FROM public.establishment_general_units WHERE location_id = p_location_id) THEN
    -- Identificadores y fechas derivados del establecimiento: crear o rellenar dos veces da filas idénticas.
    INSERT INTO public.units (id, location_id, organization_id, name, created_at, updated_at)
    VALUES (public.app_residential_stable_uuid('etnara-residential-general-unit:' || p_location_id::text), p_location_id, v_org, 'General', v_created, v_created)
    RETURNING id INTO v_unit;
    INSERT INTO public.establishment_general_units (location_id, organization_id, unit_id) VALUES (p_location_id, v_org, v_unit);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.establishment_technical_rooms WHERE location_id = p_location_id) THEN
    INSERT INTO public.units (id, location_id, organization_id, name, created_at, updated_at)
    VALUES (public.app_residential_stable_uuid('etnara-residential-technical-unit:' || p_location_id::text), p_location_id, v_org, '__etnara_technical__', v_created, v_created)
    RETURNING id INTO v_unit;
    INSERT INTO public.rooms (id, unit_id, organization_id, name, created_at, updated_at)
    VALUES (public.app_residential_stable_uuid('etnara-residential-technical-room:' || p_location_id::text), v_unit, v_org, '__etnara_technical__', v_created, v_created)
    RETURNING id INTO v_room;
    INSERT INTO public.establishment_technical_rooms (location_id, organization_id, unit_id, room_id) VALUES (p_location_id, v_org, v_unit, v_room);
  END IF;

  INSERT INTO public.establishment_settings (location_id, organization_id) VALUES (p_location_id, v_org)
  ON CONFLICT (location_id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_ensure_establishment(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_residential_location_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.app_residential_ensure_establishment(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_location_after_insert() FROM PUBLIC;
DROP TRIGGER IF EXISTS locations_residential_ensure ON locations;
CREATE TRIGGER locations_residential_ensure AFTER INSERT ON locations
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_location_after_insert();

-- 5. Guardas ------------------------------------------------------------------------------------------------------
-- 5a. Establecimientos de hogar: solo se archivan (o reabren) mediante el procedimiento de cierre.
CREATE OR REPLACE FUNCTION public.app_residential_location_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at
     AND public.app_org_is_residential(OLD.organization_id)
     AND NOT public.app_residential_in_procedure() THEN
    RAISE EXCEPTION 'RESIDENTIAL_CLOSURE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_location_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS locations_residential_guard ON locations;
CREATE TRIGGER locations_residential_guard BEFORE UPDATE OF archived_at ON locations
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_location_guard();

-- 5b. Unidades.
CREATE OR REPLACE FUNCTION public.app_residential_unit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.units;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP IN ('UPDATE', 'DELETE') AND public.app_is_technical_unit(OLD.id) AND NOT public.app_residential_in_procedure() THEN
    RAISE EXCEPTION 'RESIDENTIAL_TECHNICAL_PROTECTED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.app_org_is_residential(OLD.organization_id) AND NOT public.app_residential_in_procedure() THEN
      RAISE EXCEPTION 'RESIDENTIAL_ARCHIVE_NOT_DELETE' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT public.app_org_is_residential(v_row.organization_id) OR public.app_residential_in_procedure() THEN
    RETURN NEW;
  END IF;
  IF char_length(btrim(NEW.name)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'RESIDENTIAL_INVALID_NAME' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'RESIDENTIAL_UNIT_LOCATION_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.locations l WHERE l.id = NEW.location_id AND l.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'RESIDENTIAL_ESTABLISHMENT_CLOSED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR lower(btrim(NEW.name)) IS DISTINCT FROM lower(btrim(OLD.name)) OR OLD.archived_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM public.units u WHERE u.location_id = NEW.location_id AND u.id <> NEW.id AND u.archived_at IS NULL
                 AND lower(btrim(u.name)) = lower(btrim(NEW.name))) THEN
    RAISE EXCEPTION 'RESIDENTIAL_NAME_TAKEN' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.rooms r WHERE r.unit_id = NEW.id AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'RESIDENTIAL_UNIT_HAS_ACTIVE_ROOMS' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_unit_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS units_residential_guard ON units;
CREATE TRIGGER units_residential_guard BEFORE INSERT OR UPDATE OR DELETE ON units
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_unit_guard();

-- 5c. Habitaciones.
CREATE OR REPLACE FUNCTION public.app_residential_room_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new_loc uuid;
  v_old_loc uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND public.app_is_technical_room(OLD.id) AND NOT public.app_residential_in_procedure() THEN
    RAISE EXCEPTION 'RESIDENTIAL_TECHNICAL_PROTECTED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.app_org_is_residential(OLD.organization_id) AND NOT public.app_residential_in_procedure() THEN
      RAISE EXCEPTION 'RESIDENTIAL_ARCHIVE_NOT_DELETE' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  -- Nadie más entra en la unidad técnica (la habitación técnica se crea antes de registrarse).
  IF public.app_is_technical_unit(NEW.unit_id) AND (TG_OP = 'INSERT' OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_TECHNICAL_PROTECTED' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.app_org_is_residential(NEW.organization_id) OR public.app_residential_in_procedure() THEN
    RETURN NEW;
  END IF;
  IF char_length(btrim(NEW.name)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'RESIDENTIAL_INVALID_NAME' USING ERRCODE = 'P0001';
  END IF;
  SELECT u.location_id INTO v_new_loc FROM public.units u WHERE u.id = NEW.unit_id;
  IF TG_OP = 'INSERT' OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
    IF EXISTS (SELECT 1 FROM public.units u WHERE u.id = NEW.unit_id AND u.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'RESIDENTIAL_UNIT_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
    SELECT u.location_id INTO v_old_loc FROM public.units u WHERE u.id = OLD.unit_id;
    IF v_old_loc IS DISTINCT FROM v_new_loc THEN
      RAISE EXCEPTION 'RESIDENTIAL_ROOM_LOCATION_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.archived_at IS NULL AND (TG_OP = 'INSERT' OR lower(btrim(NEW.name)) IS DISTINCT FROM lower(btrim(OLD.name)) OR OLD.archived_at IS NOT NULL OR NEW.unit_id IS DISTINCT FROM OLD.unit_id)
     AND EXISTS (SELECT 1 FROM public.rooms r JOIN public.units u ON u.id = r.unit_id
                 WHERE u.location_id = v_new_loc AND r.id <> NEW.id AND r.archived_at IS NULL
                   AND lower(btrim(r.name)) = lower(btrim(NEW.name))) THEN
    RAISE EXCEPTION 'RESIDENTIAL_NAME_TAKEN' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.care_recipients cr WHERE cr.room_id = NEW.id AND cr.status = 'active') THEN
    RAISE EXCEPTION 'RESIDENTIAL_ROOM_HAS_RESIDENTS' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_room_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS rooms_residential_guard ON rooms;
CREATE TRIGGER rooms_residential_guard BEFORE INSERT OR UPDATE OR DELETE ON rooms
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_room_guard();

-- 5d. Residentes: la habitación técnica nunca tiene residentes; en hogares, habitación activa y del mismo
--     establecimiento.
CREATE OR REPLACE FUNCTION public.app_residential_recipient_room_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_room_loc uuid;
  v_room_archived timestamptz;
  v_unit_archived timestamptz;
BEGIN
  IF NEW.room_id IS NOT NULL AND public.app_is_technical_room(NEW.room_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_TECHNICAL_ROOM_NO_RESIDENTS' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.room_id IS NULL OR NOT public.app_org_is_residential(NEW.organization_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id THEN
    RETURN NEW;
  END IF;
  SELECT u.location_id, r.archived_at, u.archived_at INTO v_room_loc, v_room_archived, v_unit_archived
  FROM public.rooms r JOIN public.units u ON u.id = r.unit_id WHERE r.id = NEW.room_id;
  IF v_room_archived IS NOT NULL OR v_unit_archived IS NOT NULL THEN
    RAISE EXCEPTION 'RESIDENTIAL_ROOM_ARCHIVED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.location_id IS DISTINCT FROM v_room_loc THEN
    RAISE EXCEPTION 'RESIDENTIAL_ROOM_LOCATION_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_recipient_room_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_recipients_residential_room_guard ON care_recipients;
CREATE TRIGGER care_recipients_residential_room_guard BEFORE INSERT OR UPDATE OF room_id, location_id ON care_recipients
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_recipient_room_guard();

-- 5e. Historial de ubicación de residentes (hogares). El motivo llega por app.residential_change_reason.
CREATE OR REPLACE FUNCTION public.app_residential_recipient_room_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_org_is_residential(NEW.organization_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.room_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.care_recipient_room_events (organization_id, care_recipient_id, from_location_id, to_location_id,
    from_room_id, to_room_id, actor_user_id, reason)
  VALUES (NEW.organization_id, NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.location_id END, NEW.location_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.room_id END, NEW.room_id,
    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
    left(NULLIF(btrim(COALESCE(current_setting('app.residential_change_reason', true), '')), ''), 500));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_recipient_room_history() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_recipients_residential_room_history ON care_recipients;
CREATE TRIGGER care_recipients_residential_room_history AFTER INSERT OR UPDATE OF room_id, location_id ON care_recipients
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_recipient_room_history();

-- 5f. Perfiles de habitación: nunca para la habitación técnica; autor y fecha automáticos.
CREATE OR REPLACE FUNCTION public.app_residential_room_profile_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.app_is_technical_room(NEW.room_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_TECHNICAL_PROTECTED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_PROFILE_IMMUTABLE_KEY' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_room_profile_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS room_profiles_guard ON room_profiles;
CREATE TRIGGER room_profiles_guard BEFORE INSERT OR UPDATE ON room_profiles
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_room_profile_guard();

-- 5g. Geocerca: motivo obligatorio, establecimiento abierto, auditoría de cada cambio.
CREATE OR REPLACE FUNCTION public.app_residential_settings_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'RESIDENTIAL_PROFILE_IMMUTABLE_KEY' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.locations l WHERE l.id = NEW.location_id AND l.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RESIDENTIAL_ESTABLISHMENT_CLOSED' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(COALESCE(current_setting('app.residential_change_reason', true), ''))) < 3 THEN
    RAISE EXCEPTION 'RESIDENTIAL_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_settings_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS establishment_settings_guard ON establishment_settings;
CREATE TRIGGER establishment_settings_guard BEFORE UPDATE ON establishment_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_settings_guard();

CREATE OR REPLACE FUNCTION public.app_residential_settings_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.geofence_radius_m IS NOT DISTINCT FROM OLD.geofence_radius_m
     AND NEW.geofence_latitude IS NOT DISTINCT FROM OLD.geofence_latitude
     AND NEW.geofence_longitude IS NOT DISTINCT FROM OLD.geofence_longitude THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.establishment_settings_events (organization_id, location_id, actor_user_id, reason,
    old_radius_m, new_radius_m, old_latitude, old_longitude, new_latitude, new_longitude)
  VALUES (NEW.organization_id, NEW.location_id, NEW.updated_by_user_id,
    left(btrim(current_setting('app.residential_change_reason', true)), 500),
    OLD.geofence_radius_m, NEW.geofence_radius_m, OLD.geofence_latitude, OLD.geofence_longitude,
    NEW.geofence_latitude, NEW.geofence_longitude);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_settings_history() FROM PUBLIC;
DROP TRIGGER IF EXISTS establishment_settings_history ON establishment_settings;
CREATE TRIGGER establishment_settings_history AFTER UPDATE ON establishment_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_settings_history();

-- 6. Procedimiento de cierre ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_residential_close_establishment(p_location_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_loc public.locations;
  v_shifts integer;
  v_assign integer;
  v_residents integer;
  v_rooms integer;
  v_units integer;
  v_links integer := 0;
  v_n integer;
BEGIN
  IF v_user IS NULL OR v_org IS NULL OR NOT public.app_is_org_manager() THEN
    RAISE EXCEPTION 'RESIDENTIAL_MANAGER_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.app_org_is_residential(v_org) THEN
    RAISE EXCEPTION 'MODALITY_NOT_AVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'RESIDENTIAL_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_loc FROM public.locations WHERE id = p_location_id AND organization_id = v_org FOR UPDATE;
  IF v_loc.id IS NULL THEN
    RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_loc.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESIDENTIAL_ESTABLISHMENT_CLOSED' USING ERRCODE = 'P0001';
  END IF;

  -- Turnos vigentes o futuros del establecimiento: por habitación (incluida la técnica) o por residente ubicado aquí.
  SELECT count(*) INTO v_shifts FROM public.shifts s
  WHERE s.organization_id = v_org AND s.status NOT IN ('cancelled', 'completed') AND s.scheduled_end > now()
    AND (s.room_id IN (SELECT r.id FROM public.rooms r JOIN public.units u ON u.id = r.unit_id WHERE u.location_id = p_location_id)
         OR s.care_recipient_id IN (SELECT cr.id FROM public.care_recipients cr WHERE cr.location_id = p_location_id));
  IF v_shifts > 0 THEN
    RAISE EXCEPTION 'RESIDENTIAL_CLOSURE_FUTURE_SHIFTS' USING ERRCODE = 'P0001', DETAIL = v_shifts::text;
  END IF;
  SELECT count(*) INTO v_assign FROM public.assignments a JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
  WHERE a.organization_id = v_org AND a.response_status IN ('pending', 'accepted') AND s.scheduled_end > now()
    AND (s.room_id IN (SELECT r.id FROM public.rooms r JOIN public.units u ON u.id = r.unit_id WHERE u.location_id = p_location_id)
         OR s.care_recipient_id IN (SELECT cr.id FROM public.care_recipients cr WHERE cr.location_id = p_location_id));
  IF v_assign > 0 THEN
    RAISE EXCEPTION 'RESIDENTIAL_CLOSURE_ACTIVE_ASSIGNMENTS' USING ERRCODE = 'P0001', DETAIL = v_assign::text;
  END IF;
  SELECT count(*) INTO v_residents FROM public.care_recipients cr WHERE cr.location_id = p_location_id AND cr.status = 'active';
  IF v_residents > 0 THEN
    RAISE EXCEPTION 'RESIDENTIAL_CLOSURE_ACTIVE_RESIDENTS' USING ERRCODE = 'P0001', DETAIL = v_residents::text;
  END IF;

  PERFORM set_config('app.residential_procedure', 'on', true);
  UPDATE public.rooms r SET archived_at = now(), updated_at = now()
  FROM public.units u WHERE u.id = r.unit_id AND u.location_id = p_location_id AND r.archived_at IS NULL;
  GET DIAGNOSTICS v_rooms = ROW_COUNT;
  UPDATE public.units u SET archived_at = now(), updated_at = now() WHERE u.location_id = p_location_id AND u.archived_at IS NULL;
  GET DIAGNOSTICS v_units = ROW_COUNT;
  UPDATE public.establishment_worker_assignments SET archived_at = now() WHERE location_id = p_location_id AND organization_id = v_org AND archived_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_links := v_links + v_n;
  UPDATE public.establishment_admin_assignments SET archived_at = now() WHERE location_id = p_location_id AND organization_id = v_org AND archived_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_links := v_links + v_n;
  UPDATE public.locations SET archived_at = now(), updated_at = now() WHERE id = p_location_id;
  PERFORM set_config('app.residential_procedure', 'off', true);

  INSERT INTO public.establishment_closures (organization_id, location_id, closed_by_user_id, reason, rooms_archived, units_archived, staff_links_archived)
  VALUES (v_org, p_location_id, v_user, btrim(p_reason), v_rooms, v_units, v_links);
  -- Las piezas técnicas se cuentan dentro, pero nunca se informan por separado.
  RETURN jsonb_build_object('closed', true,
    'roomsArchived', greatest(v_rooms - 1, 0), 'unitsArchived', greatest(v_units - 1, 0), 'staffLinksArchived', v_links);
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_close_establishment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_close_establishment(uuid, text) TO app_runtime;

-- 7. RLS y permisos -------------------------------------------------------------------------------------------------
-- units / rooms: lectura igual que antes; escritura solo administración de un hogar.
DROP POLICY IF EXISTS units_membership_required ON units;
DROP POLICY IF EXISTS units_member_read ON units;
CREATE POLICY units_member_read ON units FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
  OR app_is_superadmin());
DROP POLICY IF EXISTS units_residential_manager_insert ON units;
CREATE POLICY units_residential_manager_insert ON units FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager() AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS units_residential_manager_update ON units;
CREATE POLICY units_residential_manager_update ON units FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_org_manager() AND app_org_is_residential(organization_id));

DROP POLICY IF EXISTS rooms_membership_required ON rooms;
DROP POLICY IF EXISTS rooms_member_read ON rooms;
CREATE POLICY rooms_member_read ON rooms FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
  OR app_is_superadmin());
DROP POLICY IF EXISTS rooms_residential_manager_insert ON rooms;
CREATE POLICY rooms_residential_manager_insert ON rooms FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager() AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS rooms_residential_manager_update ON rooms;
CREATE POLICY rooms_residential_manager_update ON rooms FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_org_manager() AND app_org_is_residential(organization_id));
-- app_runtime ya tenía INSERT, UPDATE y DELETE sobre units y rooms (privilegios de base de la 017) con una política
-- que admitía a cualquier miembro activo. Desde la 171 escribir exige administración de un hogar, y se retira DELETE:
-- en hogares se archiva, nunca se borra (igual que locations en la 065).
GRANT INSERT, UPDATE ON units, rooms TO app_runtime;
REVOKE DELETE ON units, rooms FROM app_runtime;

-- Tablas nuevas.
ALTER TABLE establishment_technical_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_general_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_settings_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_recipient_room_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_closures ENABLE ROW LEVEL SECURITY;

-- Registros y perfiles: lectura de miembros activos (necesaria para excluir las piezas técnicas) o Central.
DROP POLICY IF EXISTS establishment_technical_rooms_member_read ON establishment_technical_rooms;
CREATE POLICY establishment_technical_rooms_member_read ON establishment_technical_rooms FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS establishment_general_units_member_read ON establishment_general_units;
CREATE POLICY establishment_general_units_member_read ON establishment_general_units FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS establishment_settings_member_read ON establishment_settings;
CREATE POLICY establishment_settings_member_read ON establishment_settings FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS establishment_settings_manager_update ON establishment_settings;
CREATE POLICY establishment_settings_manager_update ON establishment_settings FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS room_profiles_member_read ON room_profiles;
CREATE POLICY room_profiles_member_read ON room_profiles FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership()) OR app_is_superadmin());
DROP POLICY IF EXISTS room_profiles_manager_insert ON room_profiles;
CREATE POLICY room_profiles_manager_insert ON room_profiles FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS room_profiles_manager_update ON room_profiles;
CREATE POLICY room_profiles_manager_update ON room_profiles FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id));
-- Historiales: solo la administración los lee; nadie los escribe desde la aplicación (los escriben los disparadores).
DROP POLICY IF EXISTS establishment_settings_events_manager_read ON establishment_settings_events;
CREATE POLICY establishment_settings_events_manager_read ON establishment_settings_events FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin());
DROP POLICY IF EXISTS care_recipient_room_events_manager_read ON care_recipient_room_events;
CREATE POLICY care_recipient_room_events_manager_read ON care_recipient_room_events FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin());
DROP POLICY IF EXISTS establishment_closures_manager_read ON establishment_closures;
CREATE POLICY establishment_closures_manager_read ON establishment_closures FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin());

GRANT SELECT ON establishment_technical_rooms, establishment_general_units, establishment_settings, room_profiles,
  establishment_settings_events, care_recipient_room_events, establishment_closures TO app_runtime;
GRANT INSERT, UPDATE (bed_capacity) ON room_profiles TO app_runtime;
GRANT UPDATE (geofence_radius_m, geofence_latitude, geofence_longitude) ON establishment_settings TO app_runtime;

-- 8. Relleno de los establecimientos de hogar existentes (idempotente) ----------------------------------------------
SELECT public.app_residential_ensure_establishment(l.id)
FROM public.locations l JOIN public.organizations o ON o.id = l.organization_id
WHERE o.organization_type = 'RESIDENTIAL_CARE_HOME' AND l.archived_at IS NULL;

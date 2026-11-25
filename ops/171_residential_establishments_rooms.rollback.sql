-- Reversión de 171 (hogares F1). Ejecutar como propietario de las migraciones, solo con autorización expresa.
-- Se NIEGA si existe cualquier dato introducido por personas (no se borra historial ni trabajo del hogar):
--   habitaciones o unidades creadas por la administración, perfiles de camas, cambios de geocerca, historial de
--   ubicación de residentes, cierres, residentes con habitación en un hogar o turnos sobre una habitación técnica.
-- Si solo existen las piezas automáticas (General, unidad y habitación técnicas, configuración por defecto), las
-- retira y deja el esquema como en la 170. Sin datos de hogares, no toca ninguna fila.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM room_profiles)
     OR EXISTS (SELECT 1 FROM establishment_settings_events)
     OR EXISTS (SELECT 1 FROM care_recipient_room_events)
     OR EXISTS (SELECT 1 FROM establishment_closures)
     OR EXISTS (SELECT 1 FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id)
     OR EXISTS (SELECT 1 FROM care_recipients cr JOIN organizations o ON o.id = cr.organization_id
                WHERE o.organization_type = 'RESIDENTIAL_CARE_HOME' AND cr.room_id IS NOT NULL)
     -- Habitaciones o unidades de hogares creadas o cambiadas desde que se aplicó la 171 (las anteriores a la 171
     -- no cuentan: son datos previos y la reversión no las toca).
     OR EXISTS (SELECT 1 FROM rooms r JOIN organizations o ON o.id = r.organization_id
                WHERE o.organization_type = 'RESIDENTIAL_CARE_HOME'
                  AND r.id NOT IN (SELECT room_id FROM establishment_technical_rooms)
                  AND r.updated_at >= (SELECT applied_at FROM schema_migrations WHERE filename = '171_residential_establishments_rooms.sql'))
     OR EXISTS (SELECT 1 FROM units u JOIN organizations o ON o.id = u.organization_id
                WHERE o.organization_type = 'RESIDENTIAL_CARE_HOME'
                  AND u.id NOT IN (SELECT unit_id FROM establishment_technical_rooms)
                  AND u.updated_at >= (SELECT applied_at FROM schema_migrations WHERE filename = '171_residential_establishments_rooms.sql'))
     -- (la «General» que crea la 171 lleva la fecha del establecimiento: si cambió después, o el establecimiento es
     --  posterior a la 171, hay datos de personas y la reversión se niega)
     OR EXISTS (SELECT 1 FROM establishment_settings
                WHERE geofence_radius_m <> 100 OR geofence_latitude IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_171_REFUSED: existen datos de hogares creados en F1; revisar antes de revertir';
  END IF;
END;
$$;

-- Disparadores y funciones (primero, para poder retirar las piezas automáticas).
DROP TRIGGER IF EXISTS locations_residential_ensure ON locations;
DROP TRIGGER IF EXISTS locations_residential_guard ON locations;
DROP TRIGGER IF EXISTS units_residential_guard ON units;
DROP TRIGGER IF EXISTS rooms_residential_guard ON rooms;
DROP TRIGGER IF EXISTS care_recipients_residential_room_guard ON care_recipients;
DROP TRIGGER IF EXISTS care_recipients_residential_room_history ON care_recipients;

-- Piezas automáticas (sin datos de personas: comprobado arriba).
CREATE TEMP TABLE _r171_rooms ON COMMIT DROP AS SELECT room_id AS id FROM establishment_technical_rooms;
-- Solo las unidades que creó la 171 (identificador estable). Una «General» anterior que se adoptó no se borra.
CREATE TEMP TABLE _r171_units ON COMMIT DROP AS
  SELECT unit_id AS id FROM establishment_technical_rooms
  UNION SELECT g.unit_id FROM establishment_general_units g
        WHERE g.unit_id = public.app_residential_stable_uuid('etnara-residential-general-unit:' || g.location_id::text);
DROP TABLE IF EXISTS establishment_technical_rooms;
DROP TABLE IF EXISTS establishment_general_units;
DROP TABLE IF EXISTS room_profiles;
DROP TABLE IF EXISTS establishment_settings_events;
DROP TABLE IF EXISTS establishment_settings;
DROP TABLE IF EXISTS care_recipient_room_events;
DROP TABLE IF EXISTS establishment_closures;
DELETE FROM rooms WHERE id IN (SELECT id FROM _r171_rooms);
DELETE FROM units WHERE id IN (SELECT id FROM _r171_units);

DROP FUNCTION IF EXISTS public.app_residential_close_establishment(uuid, text);
DROP FUNCTION IF EXISTS public.app_residential_settings_history();
DROP FUNCTION IF EXISTS public.app_residential_settings_guard();
DROP FUNCTION IF EXISTS public.app_residential_room_profile_guard();
DROP FUNCTION IF EXISTS public.app_residential_recipient_room_history();
DROP FUNCTION IF EXISTS public.app_residential_recipient_room_guard();
DROP FUNCTION IF EXISTS public.app_residential_room_guard();
DROP FUNCTION IF EXISTS public.app_residential_unit_guard();
DROP FUNCTION IF EXISTS public.app_residential_location_guard();
DROP FUNCTION IF EXISTS public.app_residential_location_after_insert();
DROP FUNCTION IF EXISTS public.app_residential_ensure_establishment(uuid);
DROP FUNCTION IF EXISTS public.app_is_technical_unit(uuid);
DROP FUNCTION IF EXISTS public.app_is_technical_room(uuid);
DROP FUNCTION IF EXISTS public.app_residential_append_only();
DROP FUNCTION IF EXISTS public.app_residential_in_procedure();
DROP FUNCTION IF EXISTS public.app_residential_stable_uuid(text);

-- units / rooms: políticas y permisos exactamente como antes de la 171 (incluido DELETE, que la 171 retira).
GRANT DELETE ON units, rooms TO app_runtime;
DROP POLICY IF EXISTS units_member_read ON units;
DROP POLICY IF EXISTS units_residential_manager_insert ON units;
DROP POLICY IF EXISTS units_residential_manager_update ON units;
CREATE POLICY units_membership_required ON units USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
  OR app_is_superadmin());
DROP POLICY IF EXISTS rooms_member_read ON rooms;
DROP POLICY IF EXISTS rooms_residential_manager_insert ON rooms;
DROP POLICY IF EXISTS rooms_residential_manager_update ON rooms;
CREATE POLICY rooms_membership_required ON rooms USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_has_active_membership())
  OR app_is_superadmin());

DELETE FROM schema_migrations WHERE filename = '171_residential_establishments_rooms.sql';
COMMIT;

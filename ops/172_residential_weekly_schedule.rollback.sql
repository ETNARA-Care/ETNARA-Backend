-- Reversión de 172 (hogares F2). Ejecutar como propietario de las migraciones, solo con autorización expresa.
-- Se NIEGA si alguna semana se publicó (hay turnos reales creados por el calendario o publicaciones): esos turnos y su
-- historial no se borran. Sin publicaciones, retira las tablas del calendario (borradores y plantillas incluidos) y deja
-- el esquema como en la 171.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schedule_week_publications) OR EXISTS (SELECT 1 FROM schedule_week_shifts WHERE shift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_172_REFUSED: hay semanas publicadas con turnos reales; revisar antes de revertir';
  END IF;
END;
$$;
DROP POLICY IF EXISTS notifications_insert_schedule_week ON notifications;
DROP TABLE IF EXISTS schedule_week_publications;
DROP TABLE IF EXISTS schedule_week_shifts;
DROP TABLE IF EXISTS schedule_weeks;
DROP TABLE IF EXISTS schedule_template_slots;
DROP TABLE IF EXISTS schedule_templates;
DROP FUNCTION IF EXISTS public.app_schedule_entry_guard();
DROP FUNCTION IF EXISTS public.app_schedule_slot_guard();
DROP FUNCTION IF EXISTS public.app_schedule_week_guard();
DROP FUNCTION IF EXISTS public.app_schedule_template_guard();
DROP FUNCTION IF EXISTS public.app_schedule_location_guard(uuid, uuid);
DELETE FROM schema_migrations WHERE filename = '172_residential_weekly_schedule.sql';
COMMIT;

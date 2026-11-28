-- Reversión de 173 (hogares F4, códigos semanales). Ejecutar como propietario de las migraciones, solo con autorización
-- expresa y después de revertir la 174. Se NIEGA si la 174 sigue aplicada, si hay intentos de ponchar registrados o si
-- algún código se descargó o imprimió (está en circulación). Sin eso, retira los metadatos de los códigos (que el
-- trabajo programado puede volver a crear) y deja el esquema como en la 172. Ningún secreto vive en la base.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.attendance_punches') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK_173_REFUSED: revertir antes la 174';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_code_attempts) OR EXISTS (SELECT 1 FROM attendance_code_events WHERE event_type IN ('downloaded', 'revoked')) THEN
    RAISE EXCEPTION 'ROLLBACK_173_REFUSED: hay intentos registrados o códigos descargados o revocados; revisar antes de revertir';
  END IF;
END;
$$;
DROP TABLE IF EXISTS attendance_code_attempts;
DROP TABLE IF EXISTS attendance_code_events;
DROP TABLE IF EXISTS attendance_codes;
DROP FUNCTION IF EXISTS public.app_attendance_notify_available(timestamptz);
DROP FUNCTION IF EXISTS public.app_attendance_ensure_codes(timestamptz, text);
DROP FUNCTION IF EXISTS public.app_attendance_failed_attempts(uuid);
DROP FUNCTION IF EXISTS public.app_attendance_code_window(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.app_attendance_code_child_guard();
DROP FUNCTION IF EXISTS public.app_attendance_code_guard();
DROP FUNCTION IF EXISTS public.app_attendance_location_guard(uuid, uuid);
DELETE FROM schema_migrations WHERE filename = '173_residential_attendance_codes.sql';
COMMIT;

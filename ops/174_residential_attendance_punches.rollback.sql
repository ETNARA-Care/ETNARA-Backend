-- Reversión de 174 (hogares F4, ponches y consentimiento). Ejecutar como propietario de las migraciones, solo con
-- autorización expresa y después de revertir la 175. Se NIEGA si la 175 sigue aplicada o si existe cualquier ponche o
-- consentimiento: son registros de personas y no se borran. Sin datos, deja el esquema como en la 173.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.attendance_reviews') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK_174_REFUSED: revertir antes la 175';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_punches) OR EXISTS (SELECT 1 FROM attendance_geo_consents) THEN
    RAISE EXCEPTION 'ROLLBACK_174_REFUSED: hay ponches o consentimientos registrados; revisar antes de revertir';
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.app_attendance_my_shifts(timestamptz, timestamptz, uuid);
DROP TABLE IF EXISTS attendance_punches;
DROP TABLE IF EXISTS attendance_geo_consents;
DROP FUNCTION IF EXISTS public.app_attendance_consent_guard();
DROP FUNCTION IF EXISTS public.app_attendance_punch_guard();
DELETE FROM schema_migrations WHERE filename = '174_residential_attendance_punches.sql';
COMMIT;

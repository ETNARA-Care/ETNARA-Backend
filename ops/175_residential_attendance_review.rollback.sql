-- Reversión de 175 (hogares F4, revisión de ponches). Ejecutar como propietario de las migraciones, solo con
-- autorización expresa. Se NIEGA si existe cualquier decisión, corrección, alerta o política: son registros de
-- asistencia y su auditoría, que no se borran. Sin datos, retira las tablas y deja el esquema como en la 174.
-- Los avisos ya enviados (notifications ATTENDANCE_*) se conservan.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance_reviews) OR EXISTS (SELECT 1 FROM attendance_correction_requests)
     OR EXISTS (SELECT 1 FROM attendance_alerts) OR EXISTS (SELECT 1 FROM attendance_policies) THEN
    RAISE EXCEPTION 'ROLLBACK_175_REFUSED: hay revisiones, correcciones, alertas o políticas de asistencia; revisar antes de revertir';
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.app_attendance_scan_long_sessions(timestamptz);
DROP FUNCTION IF EXISTS public.app_attendance_record_blocked_attempt(uuid);
DROP FUNCTION IF EXISTS public.app_attendance_record_punch_alerts(uuid);
DROP FUNCTION IF EXISTS public.app_attendance_notify_managers(uuid, text, uuid);
DROP TABLE IF EXISTS attendance_alerts;
DROP TABLE IF EXISTS attendance_correction_requests;
DROP TABLE IF EXISTS attendance_reviews;
DROP TABLE IF EXISTS attendance_policies;
DROP FUNCTION IF EXISTS public.app_attendance_alert_guard();
DROP FUNCTION IF EXISTS public.app_attendance_correction_guard();
DROP FUNCTION IF EXISTS public.app_attendance_review_guard();
DROP FUNCTION IF EXISTS public.app_attendance_policy_guard();
DELETE FROM schema_migrations WHERE filename = '175_residential_attendance_review.sql';
COMMIT;

-- Reversión de 142 (tarea de vencimiento y purga de fotos). Ejecutar como el superusuario de
-- migraciones DESPUÉS de volver al backend anterior (o con PHOTO_RETENTION_JOB=off).
-- ABORTA sin cambiar nada si la tarea ya dejó rastro: registro de ejecuciones, retenciones
-- caducadas registradas o fotos eliminadas por vencimiento o conciliación. No toca 141.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM photo_retention_runs;
  IF n > 0 THEN RAISE EXCEPTION 'rollback 142 aborted: % job runs recorded (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM care_event_photo_events WHERE action = 'HOLD_EXPIRED';
  IF n > 0 THEN RAISE EXCEPTION 'rollback 142 aborted: % lapsed holds recorded by the job (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM care_event_photos WHERE deletion_kind IN ('RETENTION', 'RECONCILED');
  IF n > 0 THEN RAISE EXCEPTION 'rollback 142 aborted: % photos removed by the job (nothing changed)', n; END IF;
END $$;

DROP FUNCTION IF EXISTS public.app_photo_record_run(jsonb);
DROP FUNCTION IF EXISTS public.app_photo_last_reconciliation();
DROP FUNCTION IF EXISTS public.app_photo_mark_missing(uuid);
DROP FUNCTION IF EXISTS public.app_photo_live_keys(uuid, integer);
DROP FUNCTION IF EXISTS public.app_photo_classify_keys(text[]);
DROP FUNCTION IF EXISTS public.app_photo_purge_next(integer);
DROP FUNCTION IF EXISTS public.app_photo_mark_expired(integer);
DROP FUNCTION IF EXISTS public.app_photo_record_lapsed_holds(integer);
DROP FUNCTION IF EXISTS public.app_photo_retention_counts();
DROP FUNCTION IF EXISTS public.app_photo_retention_policy_state();
DROP FUNCTION IF EXISTS public.app_photo_job_guard();
DROP TABLE IF EXISTS photo_retention_runs;

DELETE FROM schema_migrations WHERE filename = '142_activity_photos_retention_purge.sql';
COMMIT;

-- Reversión de 144 (aviso diario de retenciones legales con revisión vencida).
-- Ejecutar como el superusuario de migraciones DESPUÉS de volver al backend anterior
-- (el anterior no arranca el aviso ni lee las columnas nuevas).
-- Los avisos PHOTO_LEGAL_HOLD_REVIEW_OVERDUE solo son recordatorios con una cifra:
-- no son prueba de nada (la retención y su historial siguen intactos en 143), así que
-- se eliminan para poder quitar las columnas. No toca 141/142/143.
BEGIN;
DROP FUNCTION IF EXISTS public.app_photo_legal_review_notify();
DELETE FROM public.notifications WHERE notification_type = 'PHOTO_LEGAL_HOLD_REVIEW_OVERDUE';
DROP INDEX IF EXISTS public.idx_notifications_legal_review_daily;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_legal_review_shape;
ALTER TABLE public.notifications DROP COLUMN IF EXISTS item_count, DROP COLUMN IF EXISTS notice_day;
DELETE FROM schema_migrations WHERE filename = '144_activity_photos_legal_review_notice.sql';
COMMIT;

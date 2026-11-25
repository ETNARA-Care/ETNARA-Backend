-- Reversión de 164 (manual, solo operaciones; el ejecutor de migraciones no la corre).
--
-- Retira el filtro de avisos a sí misma y la consulta del tipo de invitación. NO cambia datos (la 164 no toca las
-- llegadas ni ninguna tabla); los avisos que no se crearon no se recuperan.
--
-- Desplegar ANTES el backend anterior: el de la 164 llama a app_org_admin_invitation_is_independent().

BEGIN;

DROP TRIGGER IF EXISTS notifications_independent_self_filter ON notifications;
DROP FUNCTION IF EXISTS public.app_notification_independent_self_filter();
DROP FUNCTION IF EXISTS public.app_org_admin_invitation_is_independent(text);

DELETE FROM schema_migrations WHERE filename = '164_independent_practice_phase1.sql';
COMMIT;

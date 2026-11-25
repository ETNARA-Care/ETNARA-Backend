-- Reversión de 164 (manual, solo operaciones; el ejecutor de migraciones no la corre).
--
-- Retira el filtro de avisos a sí misma, el cierre automático de la llegada en prácticas y la consulta del tipo de
-- invitación. NO cambia datos: las llegadas ya registradas conservan su cierre (con su nota) y los avisos que no se
-- crearon no se recuperan.
--
-- Desplegar ANTES el backend anterior: el de la 164 llama a app_org_admin_invitation_is_independent().

BEGIN;

DROP TRIGGER IF EXISTS notifications_independent_self_filter ON notifications;
DROP FUNCTION IF EXISTS public.app_notification_independent_self_filter();
DROP TRIGGER IF EXISTS shift_arrivals_independent_close ON shift_arrivals;
DROP FUNCTION IF EXISTS public.app_shift_arrival_independent_close();
DROP FUNCTION IF EXISTS public.app_org_admin_invitation_is_independent(text);

DELETE FROM schema_migrations WHERE filename = '164_independent_practice_phase1.sql';
COMMIT;

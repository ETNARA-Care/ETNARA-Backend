-- Reversión de 163 (manual, solo operaciones; el ejecutor de migraciones no la corre).
--
-- Retira las funciones del interruptor de Central y el candado de activación (con el candado retirado, la 160 vuelve a
-- ser la única protección: app_runtime sigue sin poder escribir platform_modalities). NO cambia el estado de la modalidad
-- (platform_modalities.enabled queda como esté) y CONSERVA platform_modality_events: son registros de
-- auditoría sujetos a retención. Para retirarlos, decisión expresa (bloque comentado al final), tras exportarlos.
--
-- Desplegar ANTES el backend anterior: el de la 163 llama a estas funciones (y responde con error sin ellas).

BEGIN;

DROP TRIGGER IF EXISTS platform_modalities_activation_lock ON platform_modalities;
DROP FUNCTION IF EXISTS public.app_platform_modality_activation_lock();
DROP FUNCTION IF EXISTS public.app_ops_authorize_modality_activation(text, text, text, integer);
DROP FUNCTION IF EXISTS public.app_ops_revoke_modality_activation(text, text);
DROP FUNCTION IF EXISTS public.app_platform_set_modality(text, boolean, text);
DROP FUNCTION IF EXISTS public.app_platform_list_modalities();
-- updated_by_user_id se conserva (dato de auditoría; columna anulable, inocua para el código anterior).

-- Registro de eventos y autorizaciones de activación: se conservan (retención). Para retirarlos expresamente:
-- DROP TABLE IF EXISTS platform_modality_events;
-- DROP FUNCTION IF EXISTS public.app_platform_modality_events_immutable();
-- DROP TABLE IF EXISTS platform_modality_activation_authorizations;
-- DROP FUNCTION IF EXISTS public.app_platform_modality_authorization_guard();

COMMIT;

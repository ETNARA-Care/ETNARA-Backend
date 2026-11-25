-- Reversión de 163 (manual, solo operaciones; el ejecutor de migraciones no la corre).
--
-- Retira las funciones del interruptor de Central y el candado de activación (con el candado retirado, la 160 vuelve a
-- ser la única protección: app_runtime sigue sin poder escribir platform_modalities). NO cambia el estado de la modalidad
-- (platform_modalities.enabled queda como esté) y CONSERVA el registro de cambios y las autorizaciones cuando tienen
-- filas (retención); solo los retira si están vacíos.
--
-- Desplegar ANTES el backend anterior: el de la 163 llama a estas funciones (y responde con error sin ellas).

BEGIN;

DROP TRIGGER IF EXISTS platform_modalities_activation_lock ON platform_modalities;
DROP FUNCTION IF EXISTS public.app_platform_modality_activation_lock();
DROP FUNCTION IF EXISTS public.app_ops_authorize_modality_activation(text, text, text, integer);
DROP FUNCTION IF EXISTS public.app_ops_revoke_modality_activation(text, text);
DROP FUNCTION IF EXISTS public.app_platform_set_modality(text, boolean, text);
DROP FUNCTION IF EXISTS public.app_platform_list_modalities();
-- Registro de cambios y autorizaciones de activación: si contienen filas se CONSERVAN (retención), con la columna
-- updated_by_user_id. Si están vacíos se retiran, y el esquema queda idéntico al anterior. Nunca se borra un registro.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_modality_events LIMIT 1)
     OR EXISTS (SELECT 1 FROM platform_modality_activation_authorizations LIMIT 1) THEN
    RAISE NOTICE '163 rollback: modality events or activation authorizations exist; kept for retention';
  ELSE
    DROP TABLE platform_modality_events;
    DROP FUNCTION IF EXISTS public.app_platform_modality_events_immutable();
    DROP TABLE platform_modality_activation_authorizations;
    DROP FUNCTION IF EXISTS public.app_platform_modality_authorization_guard();
    ALTER TABLE platform_modalities DROP COLUMN IF EXISTS updated_by_user_id;
  END IF;
END $$;

DELETE FROM schema_migrations WHERE filename = '163_platform_modality_switch_central.sql';
COMMIT;

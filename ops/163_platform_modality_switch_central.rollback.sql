-- Reversión de 163 (manual, solo operaciones; el ejecutor de migraciones no la corre).
--
-- Retira las funciones del interruptor de Central. NO cambia el estado de la modalidad
-- (platform_modalities.enabled queda como esté) y CONSERVA platform_modality_events: son registros de
-- auditoría sujetos a retención. Para retirarlos, decisión expresa (bloque comentado al final), tras exportarlos.
--
-- Desplegar ANTES el backend anterior: el de la 163 llama a estas funciones (y responde con error sin ellas).

BEGIN;

DROP FUNCTION IF EXISTS public.app_platform_set_modality(text, boolean, text);
DROP FUNCTION IF EXISTS public.app_platform_list_modalities();
-- updated_by_user_id se conserva (dato de auditoría; columna anulable, inocua para el código anterior).

-- Registro de eventos: se conserva (retención). Para retirarlo expresamente:
-- DROP TABLE IF EXISTS platform_modality_events;
-- DROP FUNCTION IF EXISTS public.app_platform_modality_events_immutable();

COMMIT;

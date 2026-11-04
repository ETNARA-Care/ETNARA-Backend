-- Reversión COMPLETA de 148. Ejecutar como el superusuario de migraciones, solo si se decide
-- devolver las agencias al estado anterior a 148.
--
-- ATENCIÓN: después de esto, las agencias afectadas vuelven a recibir 409
-- EVENT_TYPE_NOT_ENABLED en todo registro de cuidado (hallazgo A1), hasta que alguien
-- configure sus tipos.
--
-- Borra SOLO las filas de organization_care_event_types que insertó 148 (relleno o agencia
-- nueva, según care_event_type_default_grants) y que siguen exactamente como las dejó 148:
-- habilitadas, sin etiqueta, sin orden y no obligatorias. Una fila que la agencia cambió
-- después se conserva. Las filas que ya existían antes de 148 nunca se tocan, porque no están
-- en el registro. Los care_events ya guardados no se ven afectados (referencian
-- care_event_types, no esta configuración).
-- Después aplica la reversión estándar (mismo contenido que 148_..._rollback.sql).
BEGIN;
DO $$
DECLARE v_deleted integer; v_kept integer;
BEGIN
  IF to_regclass('public.care_event_type_default_grants') IS NULL THEN
    RAISE NOTICE '148 completa: no hay registro de 148; no se borra ninguna configuración';
    RETURN;
  END IF;
  WITH removed AS (
    DELETE FROM organization_care_event_types oct
     USING care_event_type_default_grants g
     WHERE oct.organization_id = g.organization_id
       AND oct.care_event_type_id = g.care_event_type_id
       AND oct.is_enabled = true
       AND oct.label_override IS NULL
       AND oct.display_order IS NULL
       AND oct.is_required = false
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM removed;
  SELECT count(*) INTO v_kept
    FROM care_event_type_default_grants g
    JOIN organization_care_event_types oct
      ON oct.organization_id = g.organization_id AND oct.care_event_type_id = g.care_event_type_id;
  RAISE NOTICE '148 completa: % filas retiradas; % conservadas porque la agencia las modificó', v_deleted, v_kept;
END $$;
DROP TRIGGER IF EXISTS organizations_default_care_event_types ON organizations;
DROP FUNCTION IF EXISTS public.app_on_organization_created_care_event_types();
DROP FUNCTION IF EXISTS public.app_provision_default_care_event_types(uuid, text);
DROP FUNCTION IF EXISTS public.app_default_care_event_type_codes();
DROP TABLE IF EXISTS care_event_type_default_grants;
DELETE FROM schema_migrations WHERE filename = '148_default_care_event_types.sql';
COMMIT;

-- Reversión de 170 (hogares F0). Ejecutar como propietario de las migraciones, solo con autorización expresa.
-- Se NIEGA a revertir si existe cualquier fila o evento con los códigos nuevos: el historial de interruptores
-- es solo de anexos (108) y no se borra. En ese caso, revisar primero con ETNARA central.
-- No toca organizaciones, shifts ni ningún dato.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_features
             WHERE feature_code IN ('HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT'))
     OR EXISTS (SELECT 1 FROM organization_feature_events
             WHERE feature_code IN ('HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT')) THEN
    RAISE EXCEPTION 'ROLLBACK_170_REFUSED: existen interruptores o eventos de hogar; revisar antes de revertir';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS organization_features_modality_guard ON organization_features;
DROP FUNCTION IF EXISTS public.app_org_feature_modality_guard();

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS'));

DROP FUNCTION IF EXISTS public.app_org_is_residential(uuid);
DELETE FROM schema_migrations WHERE filename = '170_residential_modality_foundation.sql';
COMMIT;

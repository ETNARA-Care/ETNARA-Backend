-- Reversión de 157 (deja el esquema igual que con 156).
-- Las filas del interruptor CONTRACTS (estado y su historial de cambios) solo existen por 157: se borran
-- para restaurar las restricciones anteriores. No toca contratos, versiones, aceptaciones ni constancias.
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_signature_challenges', 'organization_contract_acceptances', 'contract_document_downloads', 'user_role_terms_acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_org_switch_guard', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.app_contract_org_switch_guard();

ALTER TABLE organization_feature_events DISABLE TRIGGER USER;
DELETE FROM organization_feature_events WHERE feature_code = 'CONTRACTS';
ALTER TABLE organization_feature_events ENABLE TRIGGER USER;
DELETE FROM organization_features WHERE feature_code = 'CONTRACTS';
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS'));

DELETE FROM schema_migrations WHERE filename = '157_contracts_per_agency_switch.sql';
COMMIT;

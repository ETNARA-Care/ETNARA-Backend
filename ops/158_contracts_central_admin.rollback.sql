-- Reversión de 158 (deja el esquema igual que con 157).
-- Se NIEGA si ya existen documentos de prueba dirigidos a una agencia: son evidencia y no se borran.
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM contract_documents WHERE organization_id IS NOT NULL AND kind <> 'SUBSCRIPTION_ORDER') THEN
    RAISE EXCEPTION 'ROLLBACK_158_REFUSED: existen documentos de prueba dirigidos a una agencia';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.app_platform_contract_eligible_signatories(uuid);
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_scope;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_order_scope;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_order_scope CHECK ((kind = 'SUBSCRIPTION_ORDER') = (organization_id IS NOT NULL));
DELETE FROM schema_migrations WHERE filename = '158_contracts_central_admin.sql';
COMMIT;

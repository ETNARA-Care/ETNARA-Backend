-- Reversión de 152 (deja el esquema igual que el de la migración anterior).
-- Efecto en datos: borra el catálogo, las versiones y las aceptaciones de PRUEBA (y borradores).
-- Se NIEGA si hay evidencia oficial (aceptaciones o versiones publicadas de documentos no de prueba).
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
-- Nunca con evidencia oficial: si existe una aceptación o una versión publicada/retirada de un
-- documento que NO es de prueba, la reversión se detiene y no borra nada. (Para retirar el módulo
-- con contratos reales hace falta un procedimiento aparte: exportar la evidencia, conservarla y
-- decidir con el abogado; no esta reversión.)
DO $$ BEGIN
  IF to_regclass('public.organization_contract_acceptances') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM organization_contract_acceptances WHERE NOT is_test)
       OR EXISTS (SELECT 1 FROM contract_document_versions WHERE NOT is_test AND status <> 'draft') THEN
      RAISE EXCEPTION 'CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE';
    END IF;
  END IF;
END $$;
-- La política de lectura del catálogo consulta las versiones: se quita antes de borrar las tablas.
DO $$ BEGIN
  IF to_regclass('public.contract_documents') IS NOT NULL THEN
    DROP POLICY IF EXISTS contract_documents_read ON contract_documents;
  END IF;
END $$;
DROP TABLE IF EXISTS organization_contract_acceptances;
DROP TABLE IF EXISTS contract_signature_challenges;
DROP TABLE IF EXISTS contract_document_versions;
DROP TABLE IF EXISTS contract_documents;
DROP FUNCTION IF EXISTS public.app_contract_no_truncate();
DROP FUNCTION IF EXISTS public.app_contract_acceptance_guard();
DROP FUNCTION IF EXISTS public.app_contract_challenge_guard();
DROP FUNCTION IF EXISTS public.app_contract_user_email(uuid);
DROP FUNCTION IF EXISTS public.app_contract_acceptance_facts(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_contract_version_guard();
DROP FUNCTION IF EXISTS public.app_contract_document_guard();
DROP FUNCTION IF EXISTS public.app_contract_sha256(text);
DROP FUNCTION IF EXISTS public.app_contract_authority_declaration();
DELETE FROM schema_migrations WHERE filename = '152_contract_documents.sql';
COMMIT;

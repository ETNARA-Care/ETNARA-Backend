-- Reversión de 156 (deja el esquema igual que con 155).
-- Se NIEGA si hay evidencia oficial: un Word original guardado para una versión no marcada como
-- prueba, términos por función oficiales con confirmación jurídica o publicados, o aceptaciones
-- individuales oficiales. Con solo datos de prueba borra esas filas de prueba.
-- Las descargas en formato «docx» (solo de prueba, por lo anterior) se borran para restaurar la
-- restricción de 153. Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.contract_source_files') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM contract_source_files f JOIN contract_document_versions v ON v.id = f.document_version_id WHERE NOT v.is_test)
       OR EXISTS (SELECT 1 FROM role_terms_versions WHERE NOT is_test AND (status <> 'draft' OR legal_status = 'legally_approved'))
       OR EXISTS (SELECT 1 FROM user_role_terms_acceptances WHERE NOT is_test) THEN
      RAISE EXCEPTION 'CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS user_role_terms_acceptances;
DROP TABLE IF EXISTS role_terms_versions;
DROP TABLE IF EXISTS contract_source_files;
DROP TRIGGER IF EXISTS contract_document_versions_zz156_source_guard ON contract_document_versions;
ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_legal_source_check;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_approved_source_sha256;

ALTER TABLE contract_document_downloads DISABLE TRIGGER USER;
DELETE FROM contract_document_downloads WHERE format = 'docx';
ALTER TABLE contract_document_downloads ENABLE TRIGGER USER;
ALTER TABLE contract_document_downloads DROP CONSTRAINT IF EXISTS contract_document_downloads_format_check;
ALTER TABLE contract_document_downloads ADD CONSTRAINT contract_document_downloads_format_check CHECK (format IN ('pdf', 'txt'));

DROP FUNCTION IF EXISTS public.app_role_terms_acceptance_guard();
DROP FUNCTION IF EXISTS public.app_role_terms_checkbox_text();
DROP FUNCTION IF EXISTS public.app_role_terms_user_has_role(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.app_role_terms_version_guard();
DROP FUNCTION IF EXISTS public.app_role_terms_verbatim(text, uuid);
DROP FUNCTION IF EXISTS public.app_contract_version_source_guard();
DROP FUNCTION IF EXISTS public.app_contract_source_file_stored(uuid, text);
DROP FUNCTION IF EXISTS public.app_contract_legal_reference_complete(text);
DROP FUNCTION IF EXISTS public.app_contract_source_file_guard();

DELETE FROM schema_migrations WHERE filename = '156_contract_source_files_role_terms.sql';
COMMIT;

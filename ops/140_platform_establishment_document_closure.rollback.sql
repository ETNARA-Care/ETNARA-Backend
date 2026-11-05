-- Reversión de 140: vuelve exactamente al estado de la 125 (Central lee los documentos de
-- establecimiento no archivados de todas las agencias y registra aprobado/rechazado).
-- Ejecutar como el superusuario de migraciones. No toca datos.
-- Si también se revierte el código del PR, la cola de Central vuelve a listar documentos.
BEGIN;
DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;

DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;
CREATE POLICY establishment_documents_platform_review_read ON establishment_documents FOR SELECT TO app_runtime USING (
  app_is_superadmin() AND establishment_documents.archived_at IS NULL
);

DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;
CREATE POLICY establishment_documents_platform_review_update ON establishment_documents FOR UPDATE TO app_runtime USING (
  app_is_superadmin() AND establishment_documents.archived_at IS NULL
) WITH CHECK (
  app_is_superadmin()
  AND establishment_documents.archived_at IS NULL
  AND establishment_documents.review_status IN ('approved', 'rejected')
  AND establishment_documents.reviewed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
);

DELETE FROM schema_migrations WHERE filename = '140_platform_establishment_document_closure.sql';
COMMIT;

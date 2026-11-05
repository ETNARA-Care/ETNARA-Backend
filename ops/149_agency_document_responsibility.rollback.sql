-- Reversión de 149: vuelve exactamente al estado de la 125/082.
--  * ETNARA Central vuelve a leer los documentos de establecimiento no archivados de todas las
--    agencias y a registrar aprobado/rechazado (políticas y trigger de la 125).
--  * Se retiran los triggers de B1/B2 (la cuidadora podría volver a cambiar sus credenciales por API
--    y la gerencia aprobar las propias).
-- La función del trigger se restaura literalmente desde la 125.
-- Ejecutar como el superusuario de migraciones, DESPUÉS de revertir el código del backend.
-- No toca datos: ningún documento, credencial, revisión ni versión se modifica ni se borra.
BEGIN;
-- B1/B2
DROP TRIGGER IF EXISTS organization_document_version_reviews_self_guard ON organization_document_version_reviews;
DROP TRIGGER IF EXISTS organization_credential_reviews_self_guard ON organization_credential_reviews;
DROP FUNCTION IF EXISTS public.app_credential_self_review_guard();
DROP TRIGGER IF EXISTS credentials_write_guard ON credentials;
DROP FUNCTION IF EXISTS public.app_credential_write_guard();
DROP FUNCTION IF EXISTS public.app_credential_owner_user(uuid);

-- E2
DROP POLICY IF EXISTS platform_phi_deny ON credentials;
DROP POLICY IF EXISTS platform_phi_deny ON credential_platform_verifications;
DROP POLICY IF EXISTS platform_phi_deny ON organization_credential_reviews;
DROP POLICY IF EXISTS platform_phi_deny ON organization_document_version_reviews;

-- E
DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;

GRANT UPDATE (archived_at, updated_at, review_status, reviewed_by_user_id, reviewed_at, review_reason)
  ON establishment_documents TO app_runtime;

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

CREATE OR REPLACE FUNCTION public.app_establishment_document_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Owner maintenance (migrations, ops) is not the application.
  IF current_user <> 'app_runtime' THEN
    RETURN NEW;
  END IF;
  IF app_is_superadmin() THEN
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'ESTABLISHMENT_DOCUMENT_PLATFORM_CANNOT_ARCHIVE' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.review_status IS DISTINCT FROM OLD.review_status
     OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.review_reason IS DISTINCT FROM OLD.review_reason THEN
    RAISE EXCEPTION 'ESTABLISHMENT_DOCUMENT_REVIEW_IS_PLATFORM_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DELETE FROM schema_migrations WHERE filename = '149_agency_document_responsibility.sql';
COMMIT;

-- Reversión de 153 (deja el esquema igual que con 152).
-- Se NIEGA si hay evidencia oficial: aceptaciones de documentos no marcados como prueba, o versiones
-- oficiales con aprobación jurídica registrada. Con solo datos de prueba borra las designaciones,
-- las descargas registradas, las reglas de acceso y las Órdenes de Suscripción de prueba.
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.organization_contract_acceptances') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM organization_contract_acceptances WHERE NOT is_test)
       OR EXISTS (SELECT 1 FROM contract_document_versions WHERE NOT is_test AND (status <> 'draft' OR legal_status = 'legally_approved')) THEN
      RAISE EXCEPTION 'CONTRACT_ROLLBACK_REFUSED_OFFICIAL_EVIDENCE';
    END IF;
  END IF;
END $$;

-- Las Órdenes de Suscripción (y sus filas) no existen en 152: se retiran con sus dependencias de prueba.
-- Los triggers de 152 impiden borrar evidencia; aquí solo hay datos de prueba (comprobado arriba).
ALTER TABLE organization_contract_acceptances DISABLE TRIGGER USER;
ALTER TABLE contract_signature_challenges DISABLE TRIGGER USER;
ALTER TABLE contract_document_versions DISABLE TRIGGER USER;
ALTER TABLE contract_documents DISABLE TRIGGER USER;
DELETE FROM organization_contract_acceptances a USING contract_document_versions v, contract_documents d
 WHERE a.document_version_id = v.id AND v.document_id = d.id AND d.organization_id IS NOT NULL;
DELETE FROM contract_signature_challenges c USING contract_document_versions v, contract_documents d
 WHERE c.document_version_id = v.id AND v.document_id = d.id AND d.organization_id IS NOT NULL;
DROP TABLE IF EXISTS contract_document_downloads;
DELETE FROM contract_document_versions v USING contract_documents d WHERE v.document_id = d.id AND d.organization_id IS NOT NULL;
DELETE FROM contract_documents WHERE organization_id IS NOT NULL;
ALTER TABLE organization_contract_acceptances ENABLE TRIGGER USER;
ALTER TABLE contract_signature_challenges ENABLE TRIGGER USER;
ALTER TABLE contract_document_versions ENABLE TRIGGER USER;
ALTER TABLE contract_documents ENABLE TRIGGER USER;

DROP TRIGGER IF EXISTS organization_contract_acceptances_saas_guard ON organization_contract_acceptances;
DROP TRIGGER IF EXISTS contract_signature_challenges_saas_guard ON contract_signature_challenges;
DROP TRIGGER IF EXISTS contract_document_versions_legal_guard ON contract_document_versions;
ALTER TABLE organization_contract_acceptances DROP COLUMN IF EXISTS signatory_designation_id;
ALTER TABLE organization_contract_acceptances DROP COLUMN IF EXISTS document_downloaded_at;
ALTER TABLE organization_contract_acceptances DROP COLUMN IF EXISTS consent_method;
ALTER TABLE organization_contract_acceptances DROP COLUMN IF EXISTS acceptance_checkbox_text;
DROP TABLE IF EXISTS organization_contract_enforcement;
DROP TABLE IF EXISTS organization_contract_signatories;
DROP FUNCTION IF EXISTS public.app_contract_enforcement_state(uuid);
DROP FUNCTION IF EXISTS public.app_contract_saas_signing_guard();
DROP FUNCTION IF EXISTS public.app_contract_acceptance_checkbox_text();
DROP FUNCTION IF EXISTS public.app_contract_download_guard();
DROP FUNCTION IF EXISTS public.app_contract_signatory_rule(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.app_contract_signatory_guard();
DROP FUNCTION IF EXISTS public.app_contract_org_has_operational_data(uuid);

-- Políticas de lectura de 152, literalmente.
DROP POLICY IF EXISTS contract_documents_read ON contract_documents;
CREATE POLICY contract_documents_read ON contract_documents FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (public.app_is_org_admin() AND EXISTS (
               SELECT 1 FROM contract_document_versions v
                WHERE v.document_id = contract_documents.id AND v.status IN ('published', 'retired'))));
DROP POLICY IF EXISTS contract_document_versions_read ON contract_document_versions;
CREATE POLICY contract_document_versions_read ON contract_document_versions FOR SELECT TO app_runtime
  USING (app_is_superadmin() OR (status IN ('published', 'retired') AND public.app_is_org_admin()));
DROP FUNCTION IF EXISTS public.app_contract_version_legal_guard();
DROP FUNCTION IF EXISTS public.app_contract_document_org(uuid);

ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_source_check;
ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_legal_status_check;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS commercial_terms;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS source_file_sha256;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS source_file_name;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_approved_sha256;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_approval_reference;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_approved_by_user_id;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_approved_at;
ALTER TABLE contract_document_versions DROP COLUMN IF EXISTS legal_status;
DROP INDEX IF EXISTS contract_documents_organization;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_order_scope;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_kind_check;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_kind_check CHECK (kind IN ('SERVICE_AGREEMENT', 'TERMS_OF_USE', 'PRIVACY_NOTICE',
  'DATA_PROCESSING', 'BUSINESS_ASSOCIATE', 'OTHER'));
ALTER TABLE contract_documents DROP COLUMN IF EXISTS required_for_operation;
ALTER TABLE contract_documents DROP COLUMN IF EXISTS organization_id;

-- Declaración de autoridad de 152, literalmente (las evidencias guardadas conservan su propio texto).
CREATE OR REPLACE FUNCTION public.app_contract_authority_declaration()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 'Declaro que tengo autoridad suficiente para aceptar este documento en nombre de la organización y obligarla a sus términos, y que mi nombre y cargo son verdaderos.'::text $$;

DELETE FROM schema_migrations WHERE filename = '153_contract_saas_v1.sql';
COMMIT;

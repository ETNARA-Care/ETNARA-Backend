-- Rollback of 162 (manual, ops only; never run by the migration runner).
--
-- Restores the 137 read exceptions for credentials, documents and document versions, and
-- removes the download-issuing function. The download audit table is KEPT by default:
-- its rows are audit records subject to retention. Drop it only with an explicit decision
-- (uncomment the last block), after exporting it.
--
-- Deploy the previous backend BEFORE running this: the 162 backend calls
-- app_issue_credential_document_download() and fails closed without it.

BEGIN;

DROP POLICY IF EXISTS credentials_manager_read_any_status ON credentials;
CREATE POLICY credentials_manager_read_any_status ON credentials
  FOR SELECT
  USING (public.app_manager_reads_org_worker(credentials.worker_id));

DROP POLICY IF EXISTS documents_manager_read_any_status ON documents;
CREATE POLICY documents_manager_read_any_status ON documents
  FOR SELECT
  USING (public.app_manager_reads_org_worker(documents.worker_id));

DROP POLICY IF EXISTS document_versions_manager_read_any_status ON document_versions;
CREATE POLICY document_versions_manager_read_any_status ON document_versions
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM documents d
     WHERE d.id = document_versions.document_id
       AND public.app_manager_reads_org_worker(d.worker_id)
  ));

DROP FUNCTION IF EXISTS public.app_issue_credential_document_download(uuid, uuid, uuid);

-- Audit table: kept (retention). To remove it explicitly:
-- DROP TABLE IF EXISTS credential_document_downloads;
-- DROP FUNCTION IF EXISTS public.app_credential_document_downloads_immutable();

COMMIT;

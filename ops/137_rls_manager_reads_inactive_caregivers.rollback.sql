-- Rollback of 137 (G4). Removes only what 137 created; leaves the schema as it was after 136.
-- Run as the migrations superuser. Non-destructive: only policies and one function; no data.
-- The backend code does not depend on 137 (it only matters under app_runtime), so no redeploy is needed first.
BEGIN;
DROP POLICY IF EXISTS document_versions_manager_read_any_status ON document_versions;
DROP POLICY IF EXISTS documents_manager_read_any_status ON documents;
DROP POLICY IF EXISTS credentials_manager_read_any_status ON credentials;
DROP POLICY IF EXISTS workers_manager_read_any_status ON workers;
DROP FUNCTION IF EXISTS public.app_manager_reads_org_worker(uuid);
DELETE FROM schema_migrations WHERE filename = '137_rls_manager_reads_inactive_caregivers.sql';
COMMIT;

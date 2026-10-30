-- 137: RLS gap G4 — the agency's managers keep READING a caregiver they deactivated
-- (paso 1B / G4, 30-oct-2026).
--
-- Under the restricted role app_runtime, workers, credentials, documents and
-- document_versions were visible to an agency only while the caregiver's membership
-- in it was ACTIVE. Deactivating someone therefore hid her from her own agency: no
-- profile, no place in the staff list, no credential history, and reactivation failed
-- with 404 (the code reads the worker row first). Production still connects as a role
-- that bypasses RLS, so this changes nothing there today; it aligns RLS with what the
-- code already allows (#241).
--
-- What this adds: one SELECT-only policy per table. An ORGANIZATION_ADMIN or SUPERVISOR
-- of the CURRENT agency may read a caregiver that has a membership in THAT agency, in any
-- status. Nothing else changes:
--   - writes still need the active membership (existing FOR ALL policies);
--   - other caregivers, family and other agencies see nothing new;
--   - the caregiver herself keeps exactly what she had (her own rows);
--   - platform_phi_deny (restrictive) still applies to documents and versions.
-- Additive and idempotent. No table or data changes. Rollback: ops/137_rls_manager_reads_inactive_caregivers.rollback.sql

CREATE OR REPLACE FUNCTION public.app_manager_reads_org_worker(p_worker_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- A manager of the current agency, and the worker belongs (any status) to that agency.
  -- SECURITY DEFINER: reads memberships without re-entering their RLS (no recursion).
  SELECT public.app_is_org_manager_definer()
     AND EXISTS (
       SELECT 1 FROM public.organization_worker_memberships owm
        WHERE owm.worker_id = p_worker_id
          AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     );
$$;
REVOKE ALL ON FUNCTION public.app_manager_reads_org_worker(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_manager_reads_org_worker(uuid) TO app_runtime;

DROP POLICY IF EXISTS workers_manager_read_any_status ON workers;
CREATE POLICY workers_manager_read_any_status ON workers
  FOR SELECT
  USING (public.app_manager_reads_org_worker(workers.id));

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

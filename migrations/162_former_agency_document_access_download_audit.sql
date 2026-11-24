-- 162: an agency loses ordinary access to the credentials and professional files of a caregiver
-- who no longer belongs to it, and every credential-document download is audited (24-nov-2026).
--
-- 1) Former agency (membership no longer 'active'):
--    137 added SELECT-only policies so that the managers of an agency kept reading a caregiver
--    they had deactivated (profile, credentials, documents, document versions). From now on only
--    the profile row stays readable (workers_manager_read_any_status: name, staff list, shift
--    history, reactivation). Credentials, documents and document versions are dropped from that
--    exception, so the base policies apply again (014 credentials_worker_scope /
--    documents_worker_scope, 130 stored_files_professional_read): owner, or an agency where the
--    membership is ACTIVE. Reactivating the membership restores access with no data change.
--    Historical review records (organization_credential_reviews) are NOT touched: rows are kept
--    under the applicable retention rules and stay subject to their own tenant policy (069).
--
-- 2) Download audit:
--    credential_document_downloads is append-only (user, organization, worker, credential,
--    document, version, file, occurred_at). The runtime cannot INSERT, UPDATE or DELETE it
--    directly. The only way the backend obtains the storage key of a credential document is
--    app_issue_credential_document_download(), which re-checks access with its own rules and
--    writes the event in the same transaction: no event, no key (fail-closed).
--
-- No existing row is modified or deleted. Idempotent.
-- Rollback: ops/162_former_agency_document_access_download_audit.rollback.sql

-- ---------------------------------------------------------------------------------------------
-- 1) Former agency: drop the three non-profile exceptions from 137.
-- ---------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS credentials_manager_read_any_status ON credentials;
DROP POLICY IF EXISTS documents_manager_read_any_status ON documents;
DROP POLICY IF EXISTS document_versions_manager_read_any_status ON document_versions;
-- workers_manager_read_any_status and app_manager_reads_org_worker() stay (profile only).

-- ---------------------------------------------------------------------------------------------
-- 2) Append-only download audit.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credential_document_downloads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  user_id             uuid NOT NULL,
  organization_id     uuid NOT NULL,
  worker_id           uuid NOT NULL,
  credential_id       uuid NOT NULL,
  document_id         uuid NOT NULL,
  document_version_id uuid NOT NULL,
  file_id             uuid NOT NULL,
  actor_kind          text NOT NULL CHECK (actor_kind IN ('AGENCY_MANAGER', 'CAREGIVER_SELF'))
);
-- Plain uuids on purpose (no FK): an audit record must outlive account, file or credential
-- removal and must never block it.
CREATE INDEX IF NOT EXISTS idx_cdd_org_time ON credential_document_downloads (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdd_worker_time ON credential_document_downloads (worker_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdd_document ON credential_document_downloads (document_id);

ALTER TABLE credential_document_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_document_downloads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON credential_document_downloads FROM PUBLIC;
REVOKE ALL ON credential_document_downloads FROM app_runtime;
GRANT SELECT ON credential_document_downloads TO app_runtime;

-- Read: managers of the agency the download happened in (their own audit trail).
DROP POLICY IF EXISTS credential_document_downloads_manager_read ON credential_document_downloads;
CREATE POLICY credential_document_downloads_manager_read ON credential_document_downloads
  FOR SELECT
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND public.app_is_org_manager_definer()
  );

-- Append-only for every role (including the owner): no UPDATE, no DELETE, no TRUNCATE.
CREATE OR REPLACE FUNCTION public.app_credential_document_downloads_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'DOWNLOAD_AUDIT_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS credential_document_downloads_no_update ON credential_document_downloads;
CREATE TRIGGER credential_document_downloads_no_update
  BEFORE UPDATE OR DELETE ON credential_document_downloads
  FOR EACH ROW EXECUTE FUNCTION public.app_credential_document_downloads_immutable();
DROP TRIGGER IF EXISTS credential_document_downloads_no_truncate ON credential_document_downloads;
CREATE TRIGGER credential_document_downloads_no_truncate
  BEFORE TRUNCATE ON credential_document_downloads
  FOR EACH STATEMENT EXECUTE FUNCTION public.app_credential_document_downloads_immutable();

-- ---------------------------------------------------------------------------------------------
-- 3) The single issuing point: check access, record the event, return the storage key.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_issue_credential_document_download(
  p_worker_id uuid,
  p_credential_id uuid,
  p_file_id uuid
)
RETURNS TABLE (storage_key text, original_filename text, content_type text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org  uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_kind text;
  v_document uuid;
  v_version uuid;
  v_key text;
  v_name text;
  v_type text;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'DOWNLOAD_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- The caregiver must belong to THIS agency right now (former agencies: no access).
  IF NOT EXISTS (
    SELECT 1 FROM organization_worker_memberships owm
     WHERE owm.worker_id = p_worker_id
       AND owm.organization_id = v_org
       AND owm.status = 'active'
  ) THEN
    RAISE EXCEPTION 'DOWNLOAD_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  -- Who: a manager (admin/supervisor) of this agency, or the caregiver herself.
  -- Platform administrators get no PHI here (same rule as 078); they are not managers.
  IF EXISTS (SELECT 1 FROM workers w WHERE w.id = p_worker_id AND w.user_id = v_user) THEN
    v_kind := 'CAREGIVER_SELF';
  ELSIF public.app_is_org_manager_definer() THEN
    v_kind := 'AGENCY_MANAGER';
  ELSE
    RAISE EXCEPTION 'DOWNLOAD_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  -- What: the file is an active version of THIS credential's document, owned by this caregiver.
  SELECT c.document_id, dv.id, sf.storage_key, sf.original_filename, sf.content_type
    INTO v_document, v_version, v_key, v_name, v_type
    FROM credentials c
    JOIN documents d ON d.id = c.document_id AND d.worker_id = c.worker_id
    JOIN document_versions dv ON dv.document_id = d.id AND dv.file_id = p_file_id
    JOIN stored_files sf ON sf.id = dv.file_id
   WHERE c.id = p_credential_id
     AND c.worker_id = p_worker_id
     AND sf.status = 'active'
   LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'DOWNLOAD_FILE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO credential_document_downloads
    (user_id, organization_id, worker_id, credential_id, document_id, document_version_id, file_id, actor_kind)
  VALUES
    (v_user, v_org, p_worker_id, p_credential_id, v_document, v_version, p_file_id, v_kind);

  RETURN QUERY SELECT v_key, v_name, v_type;
END;
$$;
REVOKE ALL ON FUNCTION public.app_issue_credential_document_download(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_issue_credential_document_download(uuid, uuid, uuid) TO app_runtime;
REVOKE ALL ON FUNCTION public.app_credential_document_downloads_immutable() FROM PUBLIC;

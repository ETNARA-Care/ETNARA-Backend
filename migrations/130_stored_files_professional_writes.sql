-- 130 — Security audit 26-oct-2026 (runtime role / cross-agency probe).
--
-- Finding: the policy stored_files_professional_scope (014) is FOR ALL. Its condition lets any agency where the
-- caregiver has an active membership UPDATE or DELETE the caregiver's professional files (PLATFORM_PROFESSIONAL),
-- which are shared by every agency the caregiver works for. The trigger stored_files_purpose_guard already keeps
-- storage_key, organization_id, purpose and uploaded_by_user_id immutable, but status, visibility, owner_worker_id,
-- scope_type and the descriptive columns could be changed by another agency, and rows could be deleted.
--
-- The application only ever does three things with these rows (credentialing.service.ts):
--   INSERT  a new hidden file   — the caregiver, or a manager of the current agency, uploading for the caregiver
--   UPDATE  status → 'active'   — the same person, when the upload is complete
--   SELECT                      — unchanged
-- So: reads stay exactly as before; writes are limited to the uploader finishing their own hidden upload, and only
-- the status column; nobody deletes. ORGANIZATION_OPERATIONAL files are untouched (read-only policy, written by
-- SECURITY DEFINER functions). The migration runner wraps this file in one transaction.

DROP POLICY IF EXISTS stored_files_professional_scope ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_read ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_insert ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_complete ON stored_files;

-- Same visibility as 014: the caregiver, or an agency where the caregiver is active.
CREATE POLICY stored_files_professional_read ON stored_files FOR SELECT USING (
  (scope_type = 'PLATFORM_PROFESSIONAL'::file_scope_enum AND (
     owner_worker_id IN (SELECT w.id FROM workers w WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
     OR EXISTS (SELECT 1 FROM organization_worker_memberships owm
                WHERE owm.worker_id = stored_files.owner_worker_id
                  AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                  AND owm.status = 'active'::worker_membership_status_enum)))
  OR app_is_superadmin());

-- New uploads: hidden, private, recorded as uploaded by the current user, by the caregiver or by a manager of an
-- agency where the caregiver is active.
CREATE POLICY stored_files_professional_insert ON stored_files FOR INSERT WITH CHECK (
  scope_type = 'PLATFORM_PROFESSIONAL'::file_scope_enum
  AND status = 'hidden' AND visibility = 'private'
  AND uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND (
    owner_worker_id IN (SELECT w.id FROM workers w WHERE w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    OR (app_is_org_manager() AND EXISTS (SELECT 1 FROM organization_worker_memberships owm
          WHERE owm.worker_id = stored_files.owner_worker_id
            AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND owm.status = 'active'::worker_membership_status_enum))));

-- Completion: only the uploader, only their own hidden file, and only to make it active.
CREATE POLICY stored_files_professional_complete ON stored_files FOR UPDATE
  USING (scope_type = 'PLATFORM_PROFESSIONAL'::file_scope_enum AND status = 'hidden'
         AND uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (scope_type = 'PLATFORM_PROFESSIONAL'::file_scope_enum AND status = 'active'
              AND uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- Column privileges: the runtime may change only `status`, and never deletes a file row.
REVOKE UPDATE, DELETE ON stored_files FROM app_runtime;
GRANT UPDATE (status) ON stored_files TO app_runtime;


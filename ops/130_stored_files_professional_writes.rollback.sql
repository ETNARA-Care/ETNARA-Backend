-- ROLLBACK of migration 130 (professional files: writes limited to the uploader's own hidden upload).
-- Run ONLY as the database owner, in one go. Restores exactly the 014 policy (FOR ALL) and the runtime's
-- table-level UPDATE/DELETE on stored_files. No data is touched. This reopens the finding of the 26-oct audit
-- (another agency could alter a shared caregiver's professional files): use it only if 130 blocks a real flow.

BEGIN;

DROP POLICY IF EXISTS stored_files_professional_read ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_insert ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_complete ON stored_files;
DROP POLICY IF EXISTS stored_files_professional_scope ON stored_files;

CREATE POLICY stored_files_professional_scope ON stored_files USING (
  (scope_type = 'PLATFORM_PROFESSIONAL'::file_scope_enum AND (
     owner_worker_id IN (SELECT workers.id FROM workers WHERE workers.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
     OR EXISTS (SELECT 1 FROM organization_worker_memberships owm
                WHERE owm.worker_id = stored_files.owner_worker_id
                  AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
                  AND owm.status = 'active'::worker_membership_status_enum)))
  OR app_is_superadmin());

GRANT UPDATE, DELETE ON stored_files TO app_runtime;

DELETE FROM schema_migrations WHERE filename = '130_stored_files_professional_writes.sql';

COMMIT;

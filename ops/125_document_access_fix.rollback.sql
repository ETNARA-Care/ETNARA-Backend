-- ROLLBACK of migration 125 (resident and establishment document access fix).
--
-- WARNING: this RE-BREAKS the feature. After it runs, every resident-document
-- and establishment-document route (agency and ETNARA Verified) answers 500
-- again (42501 permission denied / wrong GUC), exactly as before 125.
--
-- When to use it: ONLY if 125 itself causes an unexpected problem elsewhere
-- (for example a policy or trigger interfering with an unrelated flow) and the
-- documents feature can stay unavailable until a corrected migration ships.
-- A code-only rollback of the backend does NOT need it: the previous code
-- works the same (or fails the same) with 125 applied.
--
-- Run ONLY as the database owner, in one go. Data is not touched: no rows and
-- no stored files are deleted. platform_phi_deny on resident_documents (078)
-- is kept, it predates 125.

BEGIN;

-- New objects added by 125.
DROP TRIGGER IF EXISTS establishment_documents_update_guard ON establishment_documents;
DROP FUNCTION IF EXISTS public.app_establishment_document_update_guard();
DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;
DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;

-- Privileges back to the 066/067 state (none for app_runtime or PUBLIC).
REVOKE ALL ON resident_documents FROM app_runtime;
REVOKE ALL ON establishment_documents FROM app_runtime;
REVOKE ALL ON resident_documents FROM PUBLIC;
REVOKE ALL ON establishment_documents FROM PUBLIC;
ALTER TABLE resident_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE establishment_documents NO FORCE ROW LEVEL SECURITY;

-- 066 policies, verbatim.
DROP POLICY IF EXISTS resident_documents_establishment_read ON resident_documents;
DROP POLICY IF EXISTS resident_documents_establishment_insert ON resident_documents;
DROP POLICY IF EXISTS resident_documents_establishment_update ON resident_documents;
CREATE POLICY resident_documents_establishment_read ON resident_documents FOR SELECT USING (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY resident_documents_establishment_insert ON resident_documents FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
  AND EXISTS (SELECT 1 FROM care_recipients cr WHERE cr.id = care_recipient_id AND cr.organization_id = organization_id AND cr.location_id = establishment_id AND cr.archived_at IS NULL)
);
CREATE POLICY resident_documents_establishment_update ON resident_documents FOR UPDATE USING (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
) WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);

-- 067 policies, verbatim.
DROP POLICY IF EXISTS establishment_documents_read ON establishment_documents;
DROP POLICY IF EXISTS establishment_documents_insert ON establishment_documents;
DROP POLICY IF EXISTS establishment_documents_update ON establishment_documents;
CREATE POLICY establishment_documents_read ON establishment_documents FOR SELECT USING (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY establishment_documents_insert ON establishment_documents FOR INSERT WITH CHECK (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);
CREATE POLICY establishment_documents_update ON establishment_documents FOR UPDATE USING (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
) WITH CHECK (
 organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_id))
);

DELETE FROM schema_migrations WHERE filename = '125_document_access_fix.sql';

COMMIT;

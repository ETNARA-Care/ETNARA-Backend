-- Migration 125: resident and establishment document access fix.
--
-- 066_resident_documents.sql and 067_establishment_documents.sql shipped three
-- defects that made every document route answer 500 in production:
--   1. No GRANT to app_runtime (017's blanket grant predates these tables and
--      there are no default privileges): 42501 permission denied.
--   2. Policies read app.current_organization_id, but the backend only ever
--      sets app.current_org_id (src/context/tenantContext.ts): 0 rows, and
--      every INSERT rejected, even with grants.
--   3. The 066 insert policy compared cr.organization_id = organization_id
--      inside EXISTS, which resolves both sides to cr (always true).
--
-- This migration is additive and idempotent (DROP POLICY IF EXISTS + CREATE,
-- GRANT/REVOKE are repeatable). Authorization intent is unchanged:
--   * resident_documents: org managers (ORGANIZATION_ADMIN, SUPERVISOR) and
--     establishment admins of the resident's establishment, inside their own
--     organization. Never caregivers, relatives, other agencies or ETNARA
--     central (platform_phi_deny, 078, is kept and re-asserted).
--   * establishment_documents: same tenant rule for the agency; ETNARA central
--     keeps its "ETNARA Verified" review (platformEstablishmentDocuments.*,
--     withPlatformContext): read non-archived documents and record a review
--     decision only. These are business permits for the establishment, not
--     resident PHI, so platform_phi_deny is intentionally not applied here.
--
-- No DELETE privilege: archiving is an UPDATE and the code never deletes rows.

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON resident_documents FROM PUBLIC;
REVOKE ALL ON establishment_documents FROM PUBLIC;
REVOKE ALL ON resident_documents FROM app_runtime;
REVOKE ALL ON establishment_documents FROM app_runtime;

GRANT SELECT, INSERT ON resident_documents TO app_runtime;
-- Archive only touches these columns.
GRANT UPDATE (archived_at, updated_at) ON resident_documents TO app_runtime;

GRANT SELECT, INSERT ON establishment_documents TO app_runtime;
-- Agency archive (archived_at, updated_at) and ETNARA central review decision.
GRANT UPDATE (archived_at, updated_at, review_status, reviewed_by_user_id, reviewed_at, review_reason)
  ON establishment_documents TO app_runtime;

-- Same posture as neighbouring PHI tables (106, 108, 115, 116). The runtime
-- never owns these tables; owner-run tooling is a superuser or BYPASSRLS role.
ALTER TABLE resident_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE establishment_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE establishment_documents FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- resident_documents
DROP POLICY IF EXISTS resident_documents_establishment_read ON resident_documents;
CREATE POLICY resident_documents_establishment_read ON resident_documents FOR SELECT TO app_runtime USING (
  resident_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(resident_documents.establishment_id))
);

DROP POLICY IF EXISTS resident_documents_establishment_insert ON resident_documents;
CREATE POLICY resident_documents_establishment_insert ON resident_documents FOR INSERT TO app_runtime WITH CHECK (
  resident_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(resident_documents.establishment_id))
  AND EXISTS (
    SELECT 1 FROM care_recipients cr
    WHERE cr.id = resident_documents.care_recipient_id
      AND cr.organization_id = resident_documents.organization_id
      AND cr.location_id = resident_documents.establishment_id
      AND cr.archived_at IS NULL
  )
);

DROP POLICY IF EXISTS resident_documents_establishment_update ON resident_documents;
CREATE POLICY resident_documents_establishment_update ON resident_documents FOR UPDATE TO app_runtime USING (
  resident_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(resident_documents.establishment_id))
) WITH CHECK (
  resident_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(resident_documents.establishment_id))
);

-- The app_is_superadmin() branches above are inert: this RESTRICTIVE policy
-- (identical to 078) denies verified platform admins every row.
DROP POLICY IF EXISTS platform_phi_deny ON resident_documents;
CREATE POLICY platform_phi_deny ON resident_documents AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- ---------------------------------------------------------------- establishment_documents
DROP POLICY IF EXISTS establishment_documents_read ON establishment_documents;
CREATE POLICY establishment_documents_read ON establishment_documents FOR SELECT TO app_runtime USING (
  establishment_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_documents.establishment_id))
);

-- New uploads always start pending and must target an establishment of the
-- same organization (the service already checks this; now RLS does too).
DROP POLICY IF EXISTS establishment_documents_insert ON establishment_documents;
CREATE POLICY establishment_documents_insert ON establishment_documents FOR INSERT TO app_runtime WITH CHECK (
  establishment_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_documents.establishment_id))
  AND establishment_documents.review_status = 'pending'
  AND EXISTS (
    SELECT 1 FROM locations l
    WHERE l.id = establishment_documents.establishment_id
      AND l.organization_id = establishment_documents.organization_id
  )
);

DROP POLICY IF EXISTS establishment_documents_update ON establishment_documents;
CREATE POLICY establishment_documents_update ON establishment_documents FOR UPDATE TO app_runtime USING (
  establishment_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_documents.establishment_id))
) WITH CHECK (
  establishment_documents.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND (app_is_org_manager() OR app_is_superadmin() OR app_is_establishment_admin(establishment_documents.establishment_id))
);

-- ETNARA Verified: central (withPlatformContext, no organization selected)
-- reads the non-archived queue and records approved/rejected. Nothing else.
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

-- Review fields belong to ETNARA central; archive fields belong to the agency.
-- Neither side may touch the other's columns (column grants alone cannot
-- separate them because both share the app_runtime role). Not SECURITY
-- DEFINER: current_user is the caller, so the owner bypass below cannot be
-- reached by the application.
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
REVOKE ALL ON FUNCTION public.app_establishment_document_update_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS establishment_documents_update_guard ON establishment_documents;
CREATE TRIGGER establishment_documents_update_guard
  BEFORE UPDATE ON establishment_documents
  FOR EACH ROW EXECUTE FUNCTION public.app_establishment_document_update_guard();

-- ROLLBACK of migration 115 (activity photos — security). Run ONLY before the
-- feature was used, as the database owner, in one go. A code-only rollback does
-- NOT need it: the previous backend runs with 115 (it never wrote photos).
--
-- Security first: this script removes the photo FEATURE (functions, approval
-- states, history, photo consents, switch) but NEVER reopens the 014/033 holes:
--   - care_event_photos stays SELECT-only for app_runtime, readable by agency
--     managers only (no relative, no caregiver of another resident);
--   - relatives keep no access to stored_files.
-- It changes nothing and stops if any photo, photo consent, photo/consent-form
-- file or ACTIVITY_PHOTOS switch row exists. Procedure: ops/115_activity_photos_security.rollback.md

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM care_event_photos) THEN
    RAISE EXCEPTION 'activity photos exist: rollback aborted, nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM consent_records WHERE consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY')) THEN
    RAISE EXCEPTION 'photo consents exist: rollback aborted, nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM stored_files WHERE purpose IS NOT NULL) THEN
    RAISE EXCEPTION 'photo or consent-form files exist: rollback aborted, nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM organization_features WHERE feature_code = 'ACTIVITY_PHOTOS')
     OR EXISTS (SELECT 1 FROM organization_feature_events WHERE feature_code = 'ACTIVITY_PHOTOS') THEN
    RAISE EXCEPTION 'ACTIVITY_PHOTOS switch was used: rollback aborted, nothing changed';
  END IF;
END $$;

-- care_event_photos: policies first (they use the functions), then the feature.
DROP POLICY IF EXISTS care_event_photos_staff_read ON care_event_photos;
DROP POLICY IF EXISTS care_event_photos_family_read ON care_event_photos;
CREATE POLICY care_event_photos_manager_read ON care_event_photos FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_manager_definer());
DROP TRIGGER IF EXISTS care_event_photos_history ON care_event_photos;
DROP TRIGGER IF EXISTS care_event_photos_guard ON care_event_photos;
DROP TABLE IF EXISTS care_event_photo_events;
DROP FUNCTION IF EXISTS public.app_care_event_photo_events_append_only();
DROP FUNCTION IF EXISTS public.app_care_event_photo_history();
DROP FUNCTION IF EXISTS public.app_care_event_photo_guard();
DROP FUNCTION IF EXISTS public.app_attach_activity_photo(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_review_activity_photo(uuid, text, text);
DROP FUNCTION IF EXISTS public.app_family_can_view_activity_photo(uuid);
DROP INDEX IF EXISTS uq_care_event_photos_file;
DROP INDEX IF EXISTS idx_care_event_photos_recipient;
DROP INDEX IF EXISTS idx_care_event_photos_review;
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_status_check;
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_recipient_fk;
ALTER TABLE care_event_photos
  DROP COLUMN IF EXISTS care_recipient_id, DROP COLUMN IF EXISTS uploaded_by_user_id, DROP COLUMN IF EXISTS share_status,
  DROP COLUMN IF EXISTS reviewed_by_user_id, DROP COLUMN IF EXISTS reviewed_at, DROP COLUMN IF EXISTS review_reason,
  DROP COLUMN IF EXISTS capture_consent_id, DROP COLUMN IF EXISTS retention_until;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON care_event_photos FROM app_runtime;

-- stored_files: back to the 033 shape WITHOUT its family branch.
DROP POLICY IF EXISTS stored_files_organizational_scope ON stored_files;
CREATE POLICY stored_files_organizational_scope ON stored_files
  FOR SELECT
  USING (
    (scope_type = 'ORGANIZATION_OPERATIONAL'
     AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND NOT EXISTS (
       SELECT 1 FROM user_roles ur
       JOIN organization_memberships om ON ur.organization_membership_id = om.id
       JOIN roles r ON ur.role_id = r.id
       WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND r.code = 'FAMILY'))
    OR app_is_superadmin()
  );
DROP TRIGGER IF EXISTS stored_files_purpose_guard ON stored_files;
DROP FUNCTION IF EXISTS public.app_stored_files_purpose_guard();
ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_purpose_check;
ALTER TABLE stored_files DROP COLUMN IF EXISTS purpose;

-- consent_records: photo consent machinery.
DROP POLICY IF EXISTS consent_records_photo_manager_only ON consent_records;
DROP TRIGGER IF EXISTS consent_records_photo_guard ON consent_records;
DROP FUNCTION IF EXISTS public.app_photo_consent_guard();
DROP FUNCTION IF EXISTS public.app_record_photo_consent(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.app_revoke_photo_consent(uuid, text);
DROP FUNCTION IF EXISTS public.app_photo_consent_active(uuid, uuid, text);
DROP INDEX IF EXISTS uq_consent_records_photo_active;
ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_photo_shape_check;
ALTER TABLE consent_records
  DROP COLUMN IF EXISTS signed_form_file_id, DROP COLUMN IF EXISTS signer_role,
  DROP COLUMN IF EXISTS revoked_by_user_id, DROP COLUMN IF EXISTS revocation_reason;

DROP FUNCTION IF EXISTS public.app_photo_is_manager();
DROP FUNCTION IF EXISTS public.app_photo_ctx_user();
DROP FUNCTION IF EXISTS public.app_photo_ctx_org();

-- Switch list back to the 108 values.
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO'));

DELETE FROM schema_migrations WHERE filename = '115_activity_photos_security.sql';

-- Postconditions, same transaction: the holes stay closed.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'public.care_event_photos', 'INSERT')
     OR has_table_privilege('app_runtime', 'public.care_event_photos', 'UPDATE')
     OR has_table_privilege('app_runtime', 'public.care_event_photos', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime would regain write access to care_event_photos: rollback aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'care_event_photos'::regclass AND polname = 'care_event_photos_via_care_event') THEN
    RAISE EXCEPTION 'the 014 policy would come back: rollback aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'stored_files'::regclass
             AND pg_get_expr(polqual, polrelid) ILIKE '%care_event_photos%') THEN
    RAISE EXCEPTION 'the 033 family branch on stored_files would come back: rollback aborted';
  END IF;
END $$;

COMMIT;

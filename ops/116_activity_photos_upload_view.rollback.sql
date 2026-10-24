-- ROLLBACK of migration 116 (activity photos — upload, viewing, access log).
-- Run ONLY before the feature was used, as the database owner, in one go.
-- A code-only rollback does NOT need it (the previous backend never calls
-- these functions). 115 (security model) is NOT touched: the holes it closed
-- stay closed. Stops, changing nothing, if any photo, photo consent, photo or
-- consent-form file, or access-log row exists.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM care_event_photos) OR EXISTS (SELECT 1 FROM care_event_photo_access_log) THEN
    RAISE EXCEPTION 'activity photos or views exist: rollback aborted, nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM consent_records WHERE consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY'))
     OR EXISTS (SELECT 1 FROM stored_files WHERE purpose IS NOT NULL) THEN
    RAISE EXCEPTION 'photo consents or photo files exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.app_review_activity_photo(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.app_photo_consent_form_for_view(uuid);
DROP FUNCTION IF EXISTS public.app_create_photo_consent_form(uuid, uuid, text, text, bigint, text);
DROP FUNCTION IF EXISTS public.app_activity_photo_for_view(uuid);
DROP FUNCTION IF EXISTS public.app_create_activity_photo(uuid, uuid, text, bigint, text);
DROP FUNCTION IF EXISTS public.app_precheck_activity_photo(uuid);
DROP TABLE IF EXISTS care_event_photo_access_log;
DROP INDEX IF EXISTS uq_care_event_photos_one_per_activity;

DELETE FROM schema_migrations WHERE filename = '116_activity_photos_upload_view.sql';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '115_activity_photos_security.sql') THEN
    RAISE EXCEPTION '115 must stay applied: rollback aborted';
  END IF;
  IF has_table_privilege('app_runtime', 'public.care_event_photos', 'INSERT') THEN
    RAISE EXCEPTION 'app_runtime would write care_event_photos: rollback aborted';
  END IF;
END $$;

COMMIT;

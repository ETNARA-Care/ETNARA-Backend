-- Migration 115: activity photos — security, isolation, approval and consent (PR 1).
--
-- No upload or viewing interface yet. This migration makes the existing,
-- never-finished photo tables (007 stored_files, 011 care_event_photos,
-- 005 consent_records) safe before any photo can exist:
--
--  1. care_event_photos: the 014 policy let ANY active member of the agency
--     (family included) read every photo row and INSERT/DELETE links. A
--     relative could link another resident's file to their own relative's
--     activity and then read that file's storage_key (033 chain). Now:
--       - app_runtime has SELECT only; every write goes through SECURITY
--         DEFINER functions that check role, agency, resident and consent;
--       - managers read their agency's photos, a caregiver reads the ones
--         she uploaded, a relative reads only what app_family_can_view_activity_photo
--         allows (approved + both consents active + can_view_photos + switch on).
--  2. stored_files: relatives no longer read stored_files at all (the backend
--     will stream images, PR 2); photo and consent-form files are readable
--     only by agency managers and their uploader.
--  3. Approval states (pending/approved/rejected/withdrawn) with an
--     append-only history written by trigger for every change.
--  4. Photo consents (PHOTO_CAPTURE, PHOTO_SHARE_FAMILY) recorded by an
--     administrator or supervisor with the signed form; revocation blocks the
--     family immediately (checked at every read, nothing cached).
--  5. Switch ACTIVITY_PHOTOS, off for every agency.
--  6. ETNARA central (app_is_superadmin) gets nothing: 078 restrictive deny on
--     the tables, plus every new function refuses a platform session.
--
-- Retention: retention_until is recorded (180 days by default) but NOTHING is
-- deleted automatically; the deletion job waits for the approved policy.
-- No existing data is modified except the backfill of care_recipient_id on
-- care_event_photos (production has no photo rows: nothing could create them).

-- ---------------------------------------------------------------- 0. switch
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS'));

-- Shared guards for the functions below.
CREATE OR REPLACE FUNCTION public.app_photo_ctx_user() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION public.app_photo_ctx_org() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION public.app_photo_ctx_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_photo_ctx_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_ctx_user() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_photo_ctx_org() TO app_runtime;

-- Agency administrator or supervisor of the CURRENT agency, never a platform session.
CREATE OR REPLACE FUNCTION public.app_photo_is_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin() AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.user_id = public.app_photo_ctx_user() AND om.organization_id = public.app_photo_ctx_org()
      AND om.status = 'active' AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR'))
$$;
REVOKE ALL ON FUNCTION public.app_photo_is_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_is_manager() TO app_runtime;

-- ---------------------------------------------------------------- 1. stored_files
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS purpose text NULL;
ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_purpose_check;
ALTER TABLE stored_files ADD CONSTRAINT stored_files_purpose_check
  CHECK (purpose IS NULL OR (purpose IN ('ACTIVITY_PHOTO', 'PHOTO_CONSENT_FORM') AND scope_type = 'ORGANIZATION_OPERATIONAL'));

CREATE OR REPLACE FUNCTION public.app_stored_files_purpose_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id THEN
    RAISE EXCEPTION 'STORED_FILE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stored_files_purpose_guard ON stored_files;
CREATE TRIGGER stored_files_purpose_guard BEFORE UPDATE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION public.app_stored_files_purpose_guard();

-- Replaces 033: relatives lose direct access to stored_files (PR 2 streams the
-- image through the backend after app_family_can_view_activity_photo).
-- Ordinary operational files keep the 033 rule for staff; photo and consent
-- form files are visible only to agency managers and to their uploader.
DROP POLICY IF EXISTS stored_files_organizational_scope ON stored_files;
CREATE POLICY stored_files_organizational_scope ON stored_files
  FOR SELECT
  USING (
    (scope_type = 'ORGANIZATION_OPERATIONAL'
     AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (
       (purpose IS NULL AND NOT EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN organization_memberships om ON ur.organization_membership_id = om.id
          JOIN roles r ON ur.role_id = r.id
          WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
            AND r.code = 'FAMILY'))
       OR (purpose IS NOT NULL AND (public.app_photo_is_manager()
           OR (uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND app_has_active_membership())))
     ))
    OR app_is_superadmin()
  );

-- ---------------------------------------------------------------- 2. consent_records (photo consents)
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS signed_form_file_id uuid NULL REFERENCES stored_files(id);
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS signer_role text NULL;
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid NULL REFERENCES users(id);
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS revocation_reason text NULL;
ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_photo_shape_check;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_photo_shape_check CHECK (
  consent_type NOT IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY')
  OR (signed_form_file_id IS NOT NULL
      AND signer_role IN ('PATIENT', 'LEGAL_REPRESENTATIVE')
      AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
      AND (revoked_at IS NULL OR length(btrim(coalesce(revocation_reason, ''))) BETWEEN 3 AND 300))
) NOT VALID;
-- One active photo consent per resident and type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_records_photo_active
  ON consent_records (organization_id, care_recipient_id, consent_type)
  WHERE revoked_at IS NULL AND consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY');

-- Every writer: a photo consent needs a consent-form file of the same agency;
-- it can only be revoked (once), never edited or deleted.
CREATE OR REPLACE FUNCTION public.app_photo_consent_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') THEN
      RAISE EXCEPTION 'PHOTO_CONSENT_APPEND_ONLY' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') THEN
    IF OLD.revoked_at IS NOT NULL
       OR NEW.consent_type IS DISTINCT FROM OLD.consent_type OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
       OR NEW.signed_form_file_id IS DISTINCT FROM OLD.signed_form_file_id OR NEW.signer_role IS DISTINCT FROM OLD.signer_role
       OR NEW.family_relationship_id IS DISTINCT FROM OLD.family_relationship_id OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'PHOTO_CONSENT_ONLY_REVOCABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') AND (TG_OP = 'INSERT' OR NEW.consent_type IS DISTINCT FROM OLD.consent_type) THEN
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.stored_files f
      WHERE f.id = NEW.signed_form_file_id AND f.organization_id = NEW.organization_id
        AND f.purpose = 'PHOTO_CONSENT_FORM' AND f.status = 'active') THEN
      RAISE EXCEPTION 'PHOTO_CONSENT_FORM_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_consent_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS consent_records_photo_guard ON consent_records;
CREATE TRIGGER consent_records_photo_guard BEFORE INSERT OR UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION public.app_photo_consent_guard();

-- Photo consents are readable only by agency managers (relatives and
-- caregivers ask through app_photo_consent_active, which answers yes/no).
DROP POLICY IF EXISTS consent_records_photo_manager_only ON consent_records;
CREATE POLICY consent_records_photo_manager_only ON consent_records AS RESTRICTIVE FOR SELECT
  USING (consent_type NOT IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') OR public.app_photo_is_manager());

CREATE OR REPLACE FUNCTION public.app_photo_consent_active(p_organization_id uuid, p_care_recipient_id uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin()
     AND p_organization_id = public.app_photo_ctx_org()
     AND p_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY')
     AND EXISTS (SELECT 1 FROM public.consent_records c
                 WHERE c.organization_id = p_organization_id AND c.care_recipient_id = p_care_recipient_id
                   AND c.consent_type = p_type AND c.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.app_photo_consent_active(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_consent_active(uuid, uuid, text) TO app_runtime;

-- Record (manager, signed form required) and revoke (manager, reason required).
CREATE OR REPLACE FUNCTION public.app_record_photo_consent(p_care_recipient_id uuid, p_type text, p_signer_role text, p_signed_form_file_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_id uuid; v_version integer;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_CONSENT_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF p_type NOT IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') THEN RAISE EXCEPTION 'PHOTO_CONSENT_INVALID_TYPE' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_recipients cr WHERE cr.id = p_care_recipient_id AND cr.organization_id = v_org) THEN
    RAISE EXCEPTION 'PHOTO_RECIPIENT_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('photo-consent:' || p_care_recipient_id || ':' || p_type, 0));
  IF EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = v_org AND c.care_recipient_id = p_care_recipient_id
             AND c.consent_type = p_type AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'PHOTO_CONSENT_ALREADY_ACTIVE' USING ERRCODE = '23505';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = p_care_recipient_id AND c.consent_type = p_type;
  INSERT INTO public.consent_records (organization_id, care_recipient_id, consent_type, version, granted_by_user_id, signed_form_file_id, signer_role)
  VALUES (v_org, p_care_recipient_id, p_type, v_version, public.app_photo_ctx_user(), p_signed_form_file_id, p_signer_role)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (public.app_photo_ctx_user(), v_org, v_org, 'PHOTO_CONSENT_RECORDED', 'consent_record', v_id,
          jsonb_build_object('type', p_type, 'version', v_version, 'signerRole', p_signer_role));
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.app_record_photo_consent(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_record_photo_consent(uuid, text, text, uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_revoke_photo_consent(p_consent_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_type text;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_CONSENT_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'PHOTO_CONSENT_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  UPDATE public.consent_records SET revoked_at = now(), revoked_by_user_id = public.app_photo_ctx_user(), revocation_reason = btrim(p_reason)
   WHERE id = p_consent_id AND organization_id = v_org AND consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') AND revoked_at IS NULL
   RETURNING consent_type INTO v_type;
  IF v_type IS NULL THEN RAISE EXCEPTION 'PHOTO_CONSENT_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (public.app_photo_ctx_user(), v_org, v_org, 'PHOTO_CONSENT_REVOKED', 'consent_record', p_consent_id, jsonb_build_object('type', v_type));
END $$;
REVOKE ALL ON FUNCTION public.app_revoke_photo_consent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_revoke_photo_consent(uuid, text) TO app_runtime;

-- ---------------------------------------------------------------- 3. care_event_photos
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS care_recipient_id uuid;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS uploaded_by_user_id uuid REFERENCES users(id);
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS share_status text NOT NULL DEFAULT 'pending';
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS reviewed_by_user_id uuid REFERENCES users(id);
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS capture_consent_id uuid REFERENCES consent_records(id);
ALTER TABLE care_event_photos ADD COLUMN IF NOT EXISTS retention_until timestamptz;

UPDATE care_event_photos cep SET care_recipient_id = ce.care_recipient_id
  FROM care_events ce WHERE ce.id = cep.care_event_id AND cep.care_recipient_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM care_event_photos GROUP BY file_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'care_event_photos has a file linked twice: resolve before 115 (nothing changed)';
  END IF;
END $$;
ALTER TABLE care_event_photos ALTER COLUMN care_recipient_id SET NOT NULL;
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_status_check;
ALTER TABLE care_event_photos ADD CONSTRAINT care_event_photos_status_check CHECK (
  share_status IN ('pending', 'approved', 'rejected', 'withdrawn')
  AND (share_status = 'pending') = (reviewed_at IS NULL)
  AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
  AND (share_status NOT IN ('rejected', 'withdrawn') OR length(btrim(coalesce(review_reason, ''))) BETWEEN 3 AND 300)
);
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_recipient_fk;
ALTER TABLE care_event_photos ADD CONSTRAINT care_event_photos_recipient_fk
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_care_event_photos_file ON care_event_photos (file_id);
CREATE INDEX IF NOT EXISTS idx_care_event_photos_recipient ON care_event_photos (organization_id, care_recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_event_photos_review ON care_event_photos (organization_id, share_status) WHERE share_status = 'pending';

-- Every writer: the photo's agency, resident and activity must agree; the
-- file must be an activity photo of the same agency; identity fields never
-- change; status moves only along the allowed transitions.
CREATE OR REPLACE FUNCTION public.app_care_event_photo_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PHOTO_HISTORY_KEPT' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.care_events ce WHERE ce.id = NEW.care_event_id
                   AND ce.organization_id = NEW.organization_id AND ce.care_recipient_id = NEW.care_recipient_id) THEN
      RAISE EXCEPTION 'PHOTO_EVENT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stored_files f WHERE f.id = NEW.file_id
                   AND f.organization_id = NEW.organization_id AND f.purpose = 'ACTIVITY_PHOTO') THEN
      RAISE EXCEPTION 'PHOTO_FILE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW.share_status <> 'pending' THEN RAISE EXCEPTION 'PHOTO_STARTS_PENDING' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.care_event_id IS DISTINCT FROM OLD.care_event_id
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.consent_verified_at IS DISTINCT FROM OLD.consent_verified_at OR NEW.capture_consent_id IS DISTINCT FROM OLD.capture_consent_id THEN
    RAISE EXCEPTION 'PHOTO_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.share_status IS DISTINCT FROM OLD.share_status AND NOT (
       (OLD.share_status = 'pending'   AND NEW.share_status IN ('approved', 'rejected'))
    OR (OLD.share_status = 'approved'  AND NEW.share_status = 'withdrawn')
    OR (OLD.share_status IN ('rejected', 'withdrawn') AND NEW.share_status = 'approved')) THEN
    RAISE EXCEPTION 'PHOTO_INVALID_TRANSITION % -> %', OLD.share_status, NEW.share_status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.app_care_event_photo_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_event_photos_guard ON care_event_photos;
CREATE TRIGGER care_event_photos_guard BEFORE INSERT OR UPDATE OR DELETE ON care_event_photos
  FOR EACH ROW EXECUTE FUNCTION public.app_care_event_photo_guard();

-- Append-only history, written only by this trigger.
CREATE TABLE IF NOT EXISTS care_event_photo_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  photo_id uuid NOT NULL REFERENCES care_event_photos(id),
  care_recipient_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('UPLOADED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  from_status text NULL,
  to_status text NOT NULL,
  actor_user_id uuid NULL REFERENCES users(id),
  reason text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_care_event_photo_events_photo ON care_event_photo_events (photo_id, occurred_at);
ALTER TABLE care_event_photo_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_event_photo_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON care_event_photo_events FROM app_runtime;
GRANT SELECT ON care_event_photo_events TO app_runtime;
DROP POLICY IF EXISTS care_event_photo_events_manager_read ON care_event_photo_events;
CREATE POLICY care_event_photo_events_manager_read ON care_event_photo_events FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_photo_is_manager());
DROP POLICY IF EXISTS platform_phi_deny ON care_event_photo_events;
CREATE POLICY platform_phi_deny ON care_event_photo_events AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

CREATE OR REPLACE FUNCTION public.app_care_event_photo_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id)
    VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id, 'UPLOADED', NULL, NEW.share_status, NEW.uploaded_by_user_id);
  ELSIF NEW.share_status IS DISTINCT FROM OLD.share_status THEN
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id, reason)
    VALUES (NEW.organization_id, NEW.id, NEW.care_recipient_id,
            CASE NEW.share_status WHEN 'approved' THEN 'APPROVED' WHEN 'rejected' THEN 'REJECTED' ELSE 'WITHDRAWN' END,
            OLD.share_status, NEW.share_status, NEW.reviewed_by_user_id, NEW.review_reason);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.app_care_event_photo_history() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_event_photos_history ON care_event_photos;
CREATE TRIGGER care_event_photos_history AFTER INSERT OR UPDATE ON care_event_photos
  FOR EACH ROW EXECUTE FUNCTION public.app_care_event_photo_history();

CREATE OR REPLACE FUNCTION public.app_care_event_photo_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'HISTORY_APPEND_ONLY' USING ERRCODE = '23514'; END $$;
DROP TRIGGER IF EXISTS care_event_photo_events_append_only ON care_event_photo_events;
CREATE TRIGGER care_event_photo_events_append_only BEFORE UPDATE OR DELETE ON care_event_photo_events
  FOR EACH ROW EXECUTE FUNCTION public.app_care_event_photo_events_append_only();

-- Who may see a photo as a relative: everything is checked at every call.
CREATE OR REPLACE FUNCTION public.app_family_can_view_activity_photo(p_photo_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin() AND EXISTS (
    SELECT 1 FROM public.care_event_photos p
    JOIN public.family_relationships fr
      ON fr.care_recipient_id = p.care_recipient_id AND fr.organization_id = p.organization_id
    WHERE p.id = p_photo_id
      AND p.organization_id = public.app_photo_ctx_org()
      AND p.share_status = 'approved'
      AND fr.user_id = public.app_photo_ctx_user()
      AND fr.status = 'active' AND fr.can_view_photos = true
      AND EXISTS (SELECT 1 FROM public.organization_memberships om
                  JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                  JOIN public.roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
                  WHERE om.user_id = fr.user_id AND om.organization_id = p.organization_id AND om.status = 'active')
      AND public.app_org_feature_enabled(p.organization_id, 'ACTIVITY_PHOTOS')
      -- the capture consent the photo was taken under is still active ...
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.id = p.capture_consent_id
                  AND c.organization_id = p.organization_id AND c.revoked_at IS NULL)
      -- ... and the sharing consent active now was already active when the
      -- photo was approved (a revoked-then-renewed consent needs a new approval).
      AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = p.organization_id
                  AND c.care_recipient_id = p.care_recipient_id AND c.consent_type = 'PHOTO_SHARE_FAMILY'
                  AND c.revoked_at IS NULL AND c.granted_at <= p.reviewed_at))
$$;
REVOKE ALL ON FUNCTION public.app_family_can_view_activity_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_family_can_view_activity_photo(uuid) TO app_runtime;

-- Reads: managers of the agency, the caregiver who uploaded, or a relative
-- through the function above. Writes: none for app_runtime (functions only).
DROP POLICY IF EXISTS care_event_photos_via_care_event ON care_event_photos;
DROP POLICY IF EXISTS care_event_photos_staff_read ON care_event_photos;
DROP POLICY IF EXISTS care_event_photos_family_read ON care_event_photos;
CREATE POLICY care_event_photos_staff_read ON care_event_photos FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND (public.app_photo_is_manager()
              OR (uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND app_has_active_membership())));
CREATE POLICY care_event_photos_family_read ON care_event_photos FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_family_can_view_activity_photo(id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON care_event_photos FROM app_runtime;
GRANT SELECT ON care_event_photos TO app_runtime;

-- Attach a photo to an activity: only the caregiver who recorded it (within
-- 12 h), switch on, capture consent active, her own uploaded file.
CREATE OR REPLACE FUNCTION public.app_attach_activity_photo(p_care_event_id uuid, p_file_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user();
        v_recipient uuid; v_consent uuid; v_id uuid;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT ce.care_recipient_id INTO v_recipient
    FROM public.care_events ce
    JOIN public.organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id AND owm.organization_id = ce.organization_id
    JOIN public.workers w ON w.id = owm.worker_id
   WHERE ce.id = p_care_event_id AND ce.organization_id = v_org AND w.user_id = v_user AND owm.status = 'active'
     AND ce.created_at > now() - interval '12 hours';
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stored_files f WHERE f.id = p_file_id AND f.organization_id = v_org
                 AND f.purpose = 'ACTIVITY_PHOTO' AND f.uploaded_by_user_id = v_user AND f.status = 'active') THEN
    RAISE EXCEPTION 'PHOTO_FILE_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  SELECT c.id INTO v_consent FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL;
  IF v_consent IS NULL THEN RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.care_event_photos (organization_id, care_event_id, file_id, care_recipient_id, uploaded_by_user_id,
                                        consent_verified_at, capture_consent_id, retention_until)
  VALUES (v_org, p_care_event_id, p_file_id, v_recipient, v_user, now(), v_consent, now() + interval '180 days')
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'PHOTO_FILE_ALREADY_LINKED' USING ERRCODE = '23505';
END $$;
REVOKE ALL ON FUNCTION public.app_attach_activity_photo(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attach_activity_photo(uuid, uuid) TO app_runtime;

-- Review: administrator or supervisor of the agency. Sharing needs both consents.
CREATE OR REPLACE FUNCTION public.app_review_activity_photo(p_photo_id uuid, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); p record; v_to text;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  v_to := CASE p_decision WHEN 'APPROVE' THEN 'approved' WHEN 'REJECT' THEN 'rejected' WHEN 'WITHDRAW' THEN 'withdrawn' END;
  IF v_to IS NULL THEN RAISE EXCEPTION 'PHOTO_INVALID_DECISION' USING ERRCODE = '22023'; END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF v_to = 'approved' AND NOT (
       EXISTS (SELECT 1 FROM public.consent_records c WHERE c.id = p.capture_consent_id AND c.revoked_at IS NULL)
   AND EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = v_org AND c.care_recipient_id = p.care_recipient_id
               AND c.consent_type = 'PHOTO_SHARE_FAMILY' AND c.revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF v_to IN ('rejected', 'withdrawn') AND length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'PHOTO_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  UPDATE public.care_event_photos
     SET share_status = v_to, reviewed_by_user_id = public.app_photo_ctx_user(), reviewed_at = now(),
         review_reason = CASE WHEN v_to = 'approved' THEN NULL ELSE btrim(p_reason) END
   WHERE id = p_photo_id;
  RETURN v_to;
END $$;
REVOKE ALL ON FUNCTION public.app_review_activity_photo(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_review_activity_photo(uuid, text, text) TO app_runtime;

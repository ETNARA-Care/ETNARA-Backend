-- Migration 116: activity photos — upload, viewing and access log (PR 2).
--
-- Builds on 115 (security model). The API stores the bytes in a SEPARATE
-- private bucket (PHOTO_STORAGE_*) and talks to the database only through the
-- SECURITY DEFINER functions below, which re-check everything at every call:
--
--   app_precheck_activity_photo(care_event)            -> before any byte is stored
--   app_create_activity_photo(care_event, file, key..) -> file row + attach, one per activity
--   app_activity_photo_for_view(photo)                 -> storage key ONLY for an
--        agency manager, the uploading caregiver (active member) or a relative
--        allowed by app_family_can_view_activity_photo; relatives' views are logged
--   app_create_photo_consent_form / app_photo_consent_form_for_view -> signed forms (managers)
--
-- Storage keys never leave the backend: the API streams the bytes.
-- No data is modified. The ACTIVITY_PHOTOS switch stays off.

-- One photo per activity.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM care_event_photos GROUP BY care_event_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'an activity has more than one photo: resolve before 116 (nothing changed)';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_care_event_photos_one_per_activity ON care_event_photos (care_event_id);

-- Who viewed which photo (relatives: one row per photo, person and day).
CREATE TABLE IF NOT EXISTS care_event_photo_access_log (
  photo_id uuid NOT NULL REFERENCES care_event_photos(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  viewer_user_id uuid NOT NULL REFERENCES users(id),
  viewer_kind text NOT NULL CHECK (viewer_kind IN ('FAMILY', 'MANAGER', 'UPLOADER')),
  access_day date NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  views integer NOT NULL DEFAULT 1 CHECK (views >= 1),
  PRIMARY KEY (photo_id, viewer_user_id, access_day)
);
CREATE INDEX IF NOT EXISTS idx_photo_access_log_org ON care_event_photo_access_log (organization_id, access_day DESC);
ALTER TABLE care_event_photo_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_event_photo_access_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON care_event_photo_access_log FROM app_runtime;
GRANT SELECT ON care_event_photo_access_log TO app_runtime;
DROP POLICY IF EXISTS care_event_photo_access_log_manager_read ON care_event_photo_access_log;
CREATE POLICY care_event_photo_access_log_manager_read ON care_event_photo_access_log FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_photo_is_manager());
DROP POLICY IF EXISTS platform_phi_deny ON care_event_photo_access_log;
CREATE POLICY platform_phi_deny ON care_event_photo_access_log AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- Same checks as app_attach_activity_photo, before the bytes are stored.
-- Returns the resident of the activity (the API builds the storage key with it).
-- Shift-level check shared by the eligibility query and every upload: the
-- caller is the caregiver with an ACCEPTED assignment on a non-cancelled shift
-- of THIS agency, for THIS agency's resident. Returns the resident or raises.
CREATE OR REPLACE FUNCTION public.app_photo_shift_target(p_shift_id uuid, p_membership_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_recipient uuid;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT s.care_recipient_id INTO v_recipient
    FROM public.shifts s
    JOIN public.care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
    JOIN public.assignments a ON a.shift_id = s.id AND a.organization_id = s.organization_id AND a.response_status = 'accepted'
    JOIN public.organization_worker_memberships owm ON owm.id = a.organization_worker_membership_id
                                                   AND owm.organization_id = s.organization_id AND owm.status = 'active'
    JOIN public.workers w ON w.id = owm.worker_id AND w.user_id = v_user
   WHERE s.id = p_shift_id AND s.organization_id = v_org AND s.status <> 'cancelled'
     AND (p_membership_id IS NULL OR owm.id = p_membership_id)
   LIMIT 1;
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN v_recipient;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_shift_target(uuid, uuid) FROM PUBLIC;

-- Every check for attaching a photo to one activity: organisation, resident,
-- the caregiver who wrote it and is still assigned (accepted) to its shift,
-- the activity itself (≤ 12 h old, no photo yet) and the capture consent.
CREATE OR REPLACE FUNCTION public.app_precheck_activity_photo(p_care_event_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); ev record;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT ce.care_recipient_id, ce.shift_id, ce.organization_worker_membership_id AS owm INTO ev
    FROM public.care_events ce
    JOIN public.organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id AND owm.organization_id = ce.organization_id
    JOIN public.workers w ON w.id = owm.worker_id
   WHERE ce.id = p_care_event_id AND ce.organization_id = v_org AND w.user_id = v_user AND owm.status = 'active'
     AND ce.created_at > now() - interval '12 hours';
  IF NOT FOUND OR ev.care_recipient_id IS NULL OR ev.shift_id IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  -- Same shift, same resident, still assigned to the author.
  IF public.app_photo_shift_target(ev.shift_id, ev.owm) IS DISTINCT FROM ev.care_recipient_id THEN
    RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = v_org AND c.care_recipient_id = ev.care_recipient_id
                 AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.care_event_id = p_care_event_id) THEN
    RAISE EXCEPTION 'PHOTO_ALREADY_ATTACHED' USING ERRCODE = '23505';
  END IF;
  RETURN ev.care_recipient_id;
END $$;
REVOKE ALL ON FUNCTION public.app_precheck_activity_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_precheck_activity_photo(uuid) TO app_runtime;

-- Eligibility (caregiver): ONLY true/false. Nothing about the consent (form,
-- signer, dates, type) is returned. Anything the caller may not see raises
-- (→ 404). It grants nothing: every upload repeats all the checks.
CREATE OR REPLACE FUNCTION public.app_shift_photo_eligibility(p_shift_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_recipient uuid := public.app_photo_shift_target(p_shift_id, NULL);
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.consent_records c WHERE c.organization_id = public.app_photo_ctx_org()
                 AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.app_shift_photo_eligibility(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_shift_photo_eligibility(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_activity_photo_eligibility(p_care_event_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_precheck_activity_photo(p_care_event_id);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN ('PHOTO_CONSENT_REQUIRED', 'PHOTO_ALREADY_ATTACHED') THEN RETURN false; END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.app_activity_photo_eligibility(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_activity_photo_eligibility(uuid) TO app_runtime;

-- Registers the stored (already sanitized) image and attaches it. The key
-- must be exactly the one the API was entitled to write.
CREATE OR REPLACE FUNCTION public.app_create_activity_photo(p_care_event_id uuid, p_file_id uuid, p_storage_key text, p_size_bytes bigint, p_checksum text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_recipient uuid; v_photo uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('activity-photo:' || p_care_event_id, 0));
  -- All checks again at upload time, whatever an earlier eligibility query said.
  v_recipient := public.app_precheck_activity_photo(p_care_event_id);
  -- Hold the capture consent until commit: a revocation committed first makes
  -- this find nothing (rejected); one arriving later waits for the upload.
  PERFORM 1 FROM public.consent_records c
   WHERE c.organization_id = v_org AND c.care_recipient_id = v_recipient AND c.consent_type = 'PHOTO_CAPTURE' AND c.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_CONSENT_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.care_event_id = p_care_event_id) THEN
    RAISE EXCEPTION 'PHOTO_ALREADY_ATTACHED' USING ERRCODE = '23505';
  END IF;
  IF p_storage_key IS DISTINCT FROM ('activity-photos/' || v_org || '/' || v_recipient || '/' || p_file_id || '.jpg') THEN
    RAISE EXCEPTION 'PHOTO_STORAGE_KEY_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 20 * 1024 * 1024 OR p_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PHOTO_INVALID_FILE' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.stored_files (id, scope_type, organization_id, storage_key, content_type, original_filename, size_bytes,
                                   checksum, uploaded_by_user_id, visibility, status, purpose)
  VALUES (p_file_id, 'ORGANIZATION_OPERATIONAL', v_org, p_storage_key, 'image/jpeg', 'actividad.jpg', p_size_bytes,
          p_checksum, v_user, 'private', 'active', 'ACTIVITY_PHOTO');
  v_photo := public.app_attach_activity_photo(p_care_event_id, p_file_id);
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_UPLOADED', 'care_event_photo', v_photo, jsonb_build_object('careEventId', p_care_event_id));
  RETURN v_photo;
END $$;
REVOKE ALL ON FUNCTION public.app_create_activity_photo(uuid, uuid, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_create_activity_photo(uuid, uuid, text, bigint, text) TO app_runtime;

-- The only way to obtain a photo's storage key. Checked at every call;
-- relatives' views are logged (one row per photo, person and day).
CREATE OR REPLACE FUNCTION public.app_activity_photo_for_view(p_photo_id uuid)
RETURNS TABLE (storage_key text, content_type text, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_kind text; p record;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RETURN; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RETURN; END IF;
  SELECT cep.id, cep.organization_id, cep.uploaded_by_user_id, f.storage_key AS key, f.content_type AS ctype, f.size_bytes AS size
    INTO p
    FROM public.care_event_photos cep JOIN public.stored_files f ON f.id = cep.file_id
   WHERE cep.id = p_photo_id AND cep.organization_id = v_org AND f.status = 'active' AND f.purpose = 'ACTIVITY_PHOTO';
  IF NOT FOUND THEN RETURN; END IF;
  IF public.app_photo_is_manager() THEN v_kind := 'MANAGER';
  ELSIF public.app_family_can_view_activity_photo(p_photo_id) THEN v_kind := 'FAMILY';
  ELSIF p.uploaded_by_user_id = v_user AND public.app_has_active_membership() THEN v_kind := 'UPLOADER';
  ELSE RETURN;
  END IF;
  IF v_kind = 'FAMILY' THEN
    INSERT INTO public.care_event_photo_access_log (photo_id, organization_id, viewer_user_id, viewer_kind, access_day)
    VALUES (p_photo_id, v_org, v_user, v_kind, (now() AT TIME ZONE 'America/Puerto_Rico')::date)
    ON CONFLICT (photo_id, viewer_user_id, access_day)
      DO UPDATE SET views = care_event_photo_access_log.views + 1, last_viewed_at = now();
  END IF;
  storage_key := p.key; content_type := p.ctype; size_bytes := p.size;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.app_activity_photo_for_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_activity_photo_for_view(uuid) TO app_runtime;

-- Signed consent form (manager): registers the stored form for this agency's resident.
CREATE OR REPLACE FUNCTION public.app_create_photo_consent_form(p_care_recipient_id uuid, p_file_id uuid, p_storage_key text,
                                                                p_content_type text, p_size_bytes bigint, p_checksum text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_ext text;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_CONSENT_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.care_recipients cr WHERE cr.id = p_care_recipient_id AND cr.organization_id = v_org) THEN
    RAISE EXCEPTION 'PHOTO_RECIPIENT_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  v_ext := CASE p_content_type WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' END;
  IF v_ext IS NULL OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 20 * 1024 * 1024 OR p_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PHOTO_INVALID_FILE' USING ERRCODE = '22023';
  END IF;
  IF p_storage_key IS DISTINCT FROM ('photo-consent-forms/' || v_org || '/' || p_care_recipient_id || '/' || p_file_id || '.' || v_ext) THEN
    RAISE EXCEPTION 'PHOTO_STORAGE_KEY_MISMATCH' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.stored_files (id, scope_type, organization_id, storage_key, content_type, original_filename, size_bytes,
                                   checksum, uploaded_by_user_id, visibility, status, purpose)
  VALUES (p_file_id, 'ORGANIZATION_OPERATIONAL', v_org, p_storage_key, p_content_type, 'consentimiento.' || v_ext, p_size_bytes,
          p_checksum, public.app_photo_ctx_user(), 'private', 'active', 'PHOTO_CONSENT_FORM');
  RETURN p_file_id;
END $$;
REVOKE ALL ON FUNCTION public.app_create_photo_consent_form(uuid, uuid, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_create_photo_consent_form(uuid, uuid, text, text, bigint, text) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_photo_consent_form_for_view(p_consent_id uuid)
RETURNS TABLE (storage_key text, content_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT f.storage_key, f.content_type
    FROM public.consent_records c JOIN public.stored_files f ON f.id = c.signed_form_file_id
   WHERE public.app_photo_is_manager() AND c.id = p_consent_id AND c.organization_id = public.app_photo_ctx_org()
     AND c.consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY') AND f.purpose = 'PHOTO_CONSENT_FORM' AND f.status = 'active'
$$;
REVOKE ALL ON FUNCTION public.app_photo_consent_form_for_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_consent_form_for_view(uuid) TO app_runtime;

-- Review with optimistic concurrency: the API sends the status the manager was
-- looking at. If another manager decided in between, PHOTO_STATUS_CHANGED
-- (e.g. a rejection is never silently overridden by a concurrent approval).
CREATE OR REPLACE FUNCTION public.app_review_activity_photo(p_photo_id uuid, p_decision text, p_reason text, p_expected_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.app_photo_is_manager() THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
  SELECT share_status INTO v_status FROM public.care_event_photos
   WHERE id = p_photo_id AND organization_id = public.app_photo_ctx_org() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF p_expected_status IS NULL OR v_status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'PHOTO_STATUS_CHANGED' USING ERRCODE = '40001';
  END IF;
  RETURN public.app_review_activity_photo(p_photo_id, p_decision, p_reason);
END $$;
REVOKE ALL ON FUNCTION public.app_review_activity_photo(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_review_activity_photo(uuid, text, text, text) TO app_runtime;

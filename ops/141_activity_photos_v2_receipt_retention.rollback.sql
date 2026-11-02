-- Reversión de 141 (fotos de actividades v2). Ejecutar como el superusuario de migraciones,
-- DESPUÉS de volver al backend anterior (el código de 141 usa las funciones nuevas).
-- ABORTA sin cambiar nada si existe cualquier dato propio de 141: fotos eliminadas o retenidas,
-- fotos compartidas automáticamente, autorizaciones de familiares, cola de purga o cambios de política.
-- Así nunca se pierde una autorización, una eliminación ni su rastro.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM care_event_photos
   WHERE share_status = 'deleted' OR hold_first_placed_at IS NOT NULL
      OR (share_status IN ('approved', 'withdrawn') AND reviewed_by_user_id IS NULL);
  IF n > 0 THEN RAISE EXCEPTION 'rollback 141 aborted: % photo rows use 141 states (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM family_photo_receipt_events;
  IF n > 0 THEN RAISE EXCEPTION 'rollback 141 aborted: % family photo authorizations recorded (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM photo_purge_queue;
  IF n > 0 THEN RAISE EXCEPTION 'rollback 141 aborted: % rows in the purge queue (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM photo_retention_policy_events WHERE changed_by IS DISTINCT FROM 'migration 141';
  IF n > 0 THEN RAISE EXCEPTION 'rollback 141 aborted: the retention policy was changed after 141 (nothing changed)'; END IF;
END $$;

-- Funciones y políticas exactamente como en 115/116.

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

CREATE OR REPLACE FUNCTION public.app_stored_files_purpose_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id THEN
    RAISE EXCEPTION 'STORED_FILE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

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

DROP POLICY IF EXISTS care_event_photos_staff_read ON care_event_photos;
CREATE POLICY care_event_photos_staff_read ON care_event_photos FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND (public.app_photo_is_manager()
              OR (uploaded_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND app_has_active_membership())));


-- Funciones nuevas de 141.
DROP FUNCTION IF EXISTS public.app_photo_hold_write(uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.app_photo_purge_result(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.app_photo_purge_claim(uuid);
DROP FUNCTION IF EXISTS public.app_delete_activity_photo(uuid, text);
DROP FUNCTION IF EXISTS public.app_photo_uploader_can_view(uuid);
DROP FUNCTION IF EXISTS public.app_photo_hold_active(uuid);
DROP FUNCTION IF EXISTS public.app_photo_recipients(uuid);
DROP FUNCTION IF EXISTS public.app_set_family_photo_receipt(uuid, text, text);
DROP FUNCTION IF EXISTS public.app_family_photo_receipt(uuid);
DROP FUNCTION IF EXISTS public.app_photo_own_family_relationship(uuid);

-- Restricciones de 115.
ALTER TABLE care_event_photo_events DROP CONSTRAINT IF EXISTS care_event_photo_events_action_check;
ALTER TABLE care_event_photo_events ADD CONSTRAINT care_event_photo_events_action_check CHECK (action IN ('UPLOADED', 'APPROVED', 'REJECTED', 'WITHDRAWN'));
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_hold_check;
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_status_check;
ALTER TABLE care_event_photos ADD CONSTRAINT care_event_photos_status_check CHECK (((share_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text])) AND ((share_status = 'pending'::text) = (reviewed_at IS NULL)) AND ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)) AND ((share_status <> ALL (ARRAY['rejected'::text, 'withdrawn'::text])) OR ((length(btrim(COALESCE(review_reason, ''::text))) >= 3) AND (length(btrim(COALESCE(review_reason, ''::text))) <= 300)))));
ALTER TABLE care_event_photos ALTER COLUMN retention_until DROP NOT NULL;
DROP INDEX IF EXISTS idx_care_event_photos_expiry;
ALTER TABLE care_event_photos
  DROP COLUMN IF EXISTS shared_at, DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by_user_id,
  DROP COLUMN IF EXISTS deletion_kind, DROP COLUMN IF EXISTS deletion_reason, DROP COLUMN IF EXISTS hold_reason,
  DROP COLUMN IF EXISTS hold_by_user_id, DROP COLUMN IF EXISTS hold_placed_at, DROP COLUMN IF EXISTS hold_review_at,
  DROP COLUMN IF EXISTS hold_first_placed_at, DROP COLUMN IF EXISTS hold_actions, DROP COLUMN IF EXISTS purged_at,
  DROP COLUMN IF EXISTS purge_verified_at;

-- Autorización del familiar.
DROP TRIGGER IF EXISTS family_relationships_photo_receipt_guard ON family_relationships;
DROP FUNCTION IF EXISTS public.app_family_photo_receipt_guard();
ALTER TABLE family_relationships DROP CONSTRAINT IF EXISTS family_relationships_photo_receipt_check;
ALTER TABLE family_relationships DROP COLUMN IF EXISTS photo_receipt, DROP COLUMN IF EXISTS photo_receipt_at;
DROP TABLE IF EXISTS family_photo_receipt_events;

-- Cola y política.
DROP TABLE IF EXISTS photo_purge_queue;
DROP TRIGGER IF EXISTS photo_retention_policies_history ON photo_retention_policies;
DROP FUNCTION IF EXISTS public.app_photo_retention_policy_history();
DROP FUNCTION IF EXISTS public.app_photo_retention_days(text);
DROP TABLE IF EXISTS photo_retention_policy_events;
DROP TABLE IF EXISTS photo_retention_policies;
DROP FUNCTION IF EXISTS public.app_append_only_141();

DELETE FROM schema_migrations WHERE filename = '141_activity_photos_v2_receipt_retention.sql';
COMMIT;

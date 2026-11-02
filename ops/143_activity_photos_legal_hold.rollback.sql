-- Reversión de 143 (retención legal). Ejecutar como el superusuario de migraciones DESPUÉS de volver
-- al backend anterior. ABORTA sin cambiar nada si alguna vez se colocó una retención legal (para no
-- perder nunca la prueba de una obligación ni dejar sin protección una foto retenida). No toca 141/142.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM care_event_photo_events WHERE action LIKE 'LEGAL_HOLD_%';
  IF n > 0 THEN RAISE EXCEPTION 'rollback 143 aborted: % legal hold events recorded (nothing changed)', n; END IF;
  SELECT count(*) INTO n FROM care_event_photos WHERE legal_hold_basis IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'rollback 143 aborted: % photos under legal hold (nothing changed)', n; END IF;
END $$;


DROP FUNCTION IF EXISTS public.app_photo_legal_hold_write(uuid, text, text, text, timestamptz);

-- Funciones como en 141/142.

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
    IF NEW.share_status <> 'pending' OR NEW.shared_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.hold_reason IS NOT NULL THEN
      RAISE EXCEPTION 'PHOTO_STARTS_PENDING' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.care_event_id IS DISTINCT FROM OLD.care_event_id
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.consent_verified_at IS DISTINCT FROM OLD.consent_verified_at OR NEW.capture_consent_id IS DISTINCT FROM OLD.capture_consent_id
     OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
     OR (OLD.shared_at IS NOT NULL AND NEW.shared_at IS DISTINCT FROM OLD.shared_at)
     OR (OLD.hold_first_placed_at IS NOT NULL AND NEW.hold_first_placed_at IS DISTINCT FROM OLD.hold_first_placed_at)
     OR NEW.hold_actions < OLD.hold_actions THEN
    RAISE EXCEPTION 'PHOTO_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.share_status = 'deleted' THEN
    -- Terminal: only the purge marks may be filled in, once.
    IF NEW.share_status <> 'deleted' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deletion_kind IS DISTINCT FROM OLD.deletion_kind
       OR NEW.deletion_reason IS DISTINCT FROM OLD.deletion_reason OR NEW.deleted_by_user_id IS DISTINCT FROM OLD.deleted_by_user_id
       OR NEW.hold_reason IS NOT NULL OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
       OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at)
       OR (OLD.purge_verified_at IS NOT NULL AND NEW.purge_verified_at IS DISTINCT FROM OLD.purge_verified_at) THEN
      RAISE EXCEPTION 'PHOTO_DELETED_TERMINAL' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.share_status IS DISTINCT FROM OLD.share_status AND NOT (
       (OLD.share_status = 'pending'   AND NEW.share_status IN ('approved', 'rejected', 'deleted'))
    OR (OLD.share_status = 'approved'  AND NEW.share_status IN ('withdrawn', 'deleted'))
    OR (OLD.share_status IN ('rejected', 'withdrawn') AND NEW.share_status IN ('approved', 'deleted'))) THEN
    RAISE EXCEPTION 'PHOTO_INVALID_TRANSITION % -> %', OLD.share_status, NEW.share_status USING ERRCODE = '23514';
  END IF;
  IF NEW.share_status = 'deleted' AND NEW.hold_reason IS NOT NULL AND NEW.hold_review_at > now() THEN
    RAISE EXCEPTION 'PHOTO_ON_HOLD' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.app_activity_photo_for_view(p_photo_id uuid)
RETURNS TABLE (storage_key text, content_type text, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_kind text; p record;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RETURN; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RETURN; END IF;
  SELECT cep.id, cep.retention_until, f.storage_key AS key, f.content_type AS ctype, f.size_bytes AS size
    INTO p
    FROM public.care_event_photos cep JOIN public.stored_files f ON f.id = cep.file_id
   WHERE cep.id = p_photo_id AND cep.organization_id = v_org AND cep.deleted_at IS NULL
     AND f.status = 'active' AND f.purpose = 'ACTIVITY_PHOTO';
  IF NOT FOUND THEN RETURN; END IF;
  IF public.app_photo_is_manager() AND (now() < p.retention_until OR public.app_photo_hold_active(p_photo_id)) THEN v_kind := 'MANAGER';
  ELSIF public.app_family_can_view_activity_photo(p_photo_id) THEN v_kind := 'FAMILY';
  ELSIF public.app_photo_uploader_can_view(p_photo_id) THEN v_kind := 'UPLOADER';
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

CREATE OR REPLACE FUNCTION public.app_delete_activity_photo(p_photo_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); p record; v_kind text; v_reason text; v_key text;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'PHOTO_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  -- Decide the kind BEFORE locking (the window check reads the row itself).
  IF public.app_photo_is_manager() THEN
    v_kind := 'MANUAL';
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'PHOTO_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
    v_reason := btrim(p_reason);
  ELSIF public.app_photo_uploader_can_view(p_photo_id) THEN
    v_kind := 'CAREGIVER_UNDO';
    v_reason := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  ELSE
    RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_ALREADY_DELETED' USING ERRCODE = '23514'; END IF;
  IF p.hold_reason IS NOT NULL AND p.hold_review_at > now() THEN RAISE EXCEPTION 'PHOTO_ON_HOLD' USING ERRCODE = '23514'; END IF;
  SELECT f.storage_key INTO v_key FROM public.stored_files f WHERE f.id = p.file_id;
  UPDATE public.care_event_photos
     SET share_status = 'deleted', deleted_at = now(), deleted_by_user_id = v_user, deletion_kind = v_kind, deletion_reason = v_reason,
         hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL
   WHERE id = p_photo_id;
  UPDATE public.stored_files SET status = 'hidden' WHERE id = p.file_id;
  INSERT INTO public.photo_purge_queue (photo_id, organization_id, storage_key) VALUES (p_photo_id, v_org, v_key)
  ON CONFLICT (photo_id) DO NOTHING;
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_DELETED', 'care_event_photo', p_photo_id, jsonb_build_object('kind', v_kind));
  RETURN v_kind;
END $$;

CREATE OR REPLACE FUNCTION public.app_photo_mark_expired(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE pol record; r record; n integer := 0; v_key text;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO pol FROM public.photo_retention_policies WHERE purpose = 'ACTIVITY_PHOTO';
  IF pol IS NULL OR pol.status <> 'APPROVED' OR NOT pol.purge_enabled THEN
    RAISE EXCEPTION 'PHOTO_PURGE_DISABLED' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT p.id, p.organization_id, p.file_id FROM public.care_event_photos p
            WHERE p.deleted_at IS NULL AND now() >= p.retention_until
              AND NOT (p.hold_reason IS NOT NULL AND p.hold_review_at > now())
            ORDER BY p.retention_until LIMIT greatest(1, least(coalesce(p_limit, 100), 500)) FOR UPDATE SKIP LOCKED LOOP
    SELECT f.storage_key INTO v_key FROM public.stored_files f WHERE f.id = r.file_id;
    UPDATE public.care_event_photos
       SET share_status = 'deleted', deleted_at = now(), deleted_by_user_id = NULL, deletion_kind = 'RETENTION',
           deletion_reason = 'Plazo de conservación vencido (' || pol.retention_days || ' días)',
           hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL
     WHERE id = r.id;
    UPDATE public.stored_files SET status = 'hidden' WHERE id = r.file_id;
    INSERT INTO public.photo_purge_queue (photo_id, organization_id, storage_key) VALUES (r.id, r.organization_id, v_key)
    ON CONFLICT (photo_id) DO NOTHING;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.app_photo_record_run(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; pol record;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO pol FROM public.photo_retention_policies WHERE purpose = 'ACTIVITY_PHOTO';
  INSERT INTO public.photo_retention_runs (mode, started_at, policy_status, policy_days, purge_enabled, expired_due, expired_marked, held_skipped,
    holds_lapsed, queue_pending, purged_verified, purge_failed, pending_over_24h, reconciled, orphans_found, orphans_deleted, missing_marked, error_codes)
  VALUES (p->>'mode', (p->>'startedAt')::timestamptz, pol.status, pol.retention_days, pol.purge_enabled,
    coalesce((p->>'expiredDue')::int, 0), coalesce((p->>'expiredMarked')::int, 0), coalesce((p->>'heldSkipped')::int, 0),
    coalesce((p->>'holdsLapsed')::int, 0), coalesce((p->>'queuePending')::int, 0), coalesce((p->>'purgedVerified')::int, 0),
    coalesce((p->>'purgeFailed')::int, 0), coalesce((p->>'pendingOver24h')::int, 0), coalesce((p->>'reconciled')::boolean, false),
    coalesce((p->>'orphansFound')::int, 0), coalesce((p->>'orphansDeleted')::int, 0), coalesce((p->>'missingMarked')::int, 0),
    coalesce(ARRAY(SELECT left(x, 60) FROM jsonb_array_elements_text(coalesce(p->'errorCodes', '[]'::jsonb)) AS x WHERE x ~ '^[A-Za-z0-9_]{1,60}$' LIMIT 20), '{}'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

DROP FUNCTION IF EXISTS public.app_photo_retention_counts();
CREATE FUNCTION public.app_photo_retention_counts()
RETURNS TABLE (expired_due integer, held integer, holds_lapsed integer, queue_pending integer, pending_over_24h integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM public.care_event_photos p WHERE p.deleted_at IS NULL AND now() >= p.retention_until
       AND NOT (p.hold_reason IS NOT NULL AND p.hold_review_at > now())),
    (SELECT count(*)::int FROM public.care_event_photos p WHERE p.deleted_at IS NULL AND now() >= p.retention_until
       AND p.hold_reason IS NOT NULL AND p.hold_review_at > now()),
    (SELECT count(*)::int FROM public.care_event_photos p WHERE p.deleted_at IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at <= now()),
    (SELECT count(*)::int FROM public.photo_purge_queue q WHERE q.purged_at IS NULL),
    (SELECT count(*)::int FROM public.photo_purge_queue q WHERE q.purged_at IS NULL AND q.enqueued_at < now() - interval '24 hours');
END $$;
REVOKE ALL ON FUNCTION public.app_photo_retention_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_retention_counts() TO app_runtime;

DROP FUNCTION IF EXISTS public.app_photo_mark_missing(uuid);
CREATE FUNCTION public.app_photo_mark_missing(p_photo_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.care_event_photos
     SET share_status = 'deleted', deleted_at = now(), deletion_kind = 'RECONCILED', deletion_reason = 'Archivo inexistente en el almacenamiento',
         hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL,
         purged_at = now(), purge_verified_at = now()
   WHERE id = p_photo_id;
  UPDATE public.stored_files SET status = 'hidden' WHERE id = p.file_id;
  UPDATE public.stored_files SET storage_key = 'purged/' || id, checksum = NULL, size_bytes = 0, original_filename = 'purged' WHERE id = p.file_id;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status)
  VALUES (p.organization_id, p.id, p.care_recipient_id, 'PURGED', 'deleted', 'deleted');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_mark_missing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_mark_missing(uuid) TO app_runtime;

ALTER TABLE care_event_photo_events DROP CONSTRAINT IF EXISTS care_event_photo_events_action_check;
ALTER TABLE care_event_photo_events ADD CONSTRAINT care_event_photo_events_action_check CHECK (action IN (
  'UPLOADED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SHARED', 'RESHOWN', 'DELETED', 'PURGED',
  'HOLD_PLACED', 'HOLD_RENEWED', 'HOLD_RELEASED', 'HOLD_EXPIRED'));

ALTER TABLE photo_retention_runs DROP COLUMN IF EXISTS legal_held, DROP COLUMN IF EXISTS legal_review_overdue, DROP COLUMN IF EXISTS legal_held_missing;
ALTER TABLE care_event_photos DROP CONSTRAINT IF EXISTS care_event_photos_legal_hold_check;
ALTER TABLE care_event_photos DROP COLUMN IF EXISTS legal_hold_basis, DROP COLUMN IF EXISTS legal_hold_reference, DROP COLUMN IF EXISTS legal_hold_by_user_id,
  DROP COLUMN IF EXISTS legal_hold_placed_at, DROP COLUMN IF EXISTS legal_hold_review_at;

DELETE FROM schema_migrations WHERE filename = '143_activity_photos_legal_hold.sql';
COMMIT;

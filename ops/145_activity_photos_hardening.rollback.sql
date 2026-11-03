-- Reversal of 145 (activity photos hardening). Run as the migrations superuser,
-- AFTER the backend has gone back to the 144 code (the 145 code calls functions
-- dropped here), and BEFORE reverting 144.
--
-- Refuses if there are OPEN missing-file findings (review data); the closed
-- findings (and their original keys) are dropped with the table. The storage
-- identity marker object stays in the bucket (harmless). Re-applying 145 later on a
-- database with photos needs the OPERATOR binding (ops/145_photo_storage_identity.md):
-- until then removals and the job do not touch the bucket.
-- Run-log columns are kept if a run already wrote them.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.photo_missing_findings WHERE status = 'open') THEN
    RAISE EXCEPTION 'ROLLBACK_145_REFUSED: open missing-file findings must be reviewed first';
  END IF;
END $$;

-- §4 notices
DROP FUNCTION IF EXISTS public.app_notification_org_name(uuid);
DROP FUNCTION IF EXISTS public.app_org_admin_gap_notify();
DELETE FROM public.notifications WHERE notification_type IN ('AGENCY_NO_ACTIVE_ADMIN', 'PLATFORM_AGENCY_NO_ACTIVE_ADMIN');
DROP INDEX IF EXISTS public.idx_notifications_admin_gap_unread;
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_admin_gap_shape;
DROP TABLE IF EXISTS public.organization_admin_gaps;
DROP FUNCTION IF EXISTS public.app_org_has_active_admin(uuid);

-- §5 / §6 / M4 functions
DROP FUNCTION IF EXISTS public.app_platform_org_has_legal_holds(uuid);
DROP FUNCTION IF EXISTS public.app_photo_history(uuid);
DROP FUNCTION IF EXISTS public.app_photo_confidential(uuid[]);
DROP FUNCTION IF EXISTS public.app_photo_agency_mode();
DROP FUNCTION IF EXISTS public.app_photo_created_summary(uuid);
DROP FUNCTION IF EXISTS public.app_photo_kept_by_agency(uuid);

-- M4: table-level SELECT again (column grants removed first so the ACL is the same as before).
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ') INTO cols FROM pg_attribute
   WHERE attrelid = 'public.care_event_photos'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%s) ON public.care_event_photos FROM app_runtime', cols);
  SELECT string_agg(quote_ident(attname), ', ') INTO cols FROM pg_attribute
   WHERE attrelid = 'public.care_event_photo_events'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%s) ON public.care_event_photo_events FROM app_runtime', cols);
  SELECT string_agg(quote_ident(attname), ', ') INTO cols FROM pg_attribute
   WHERE attrelid = 'public.family_relationships'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON public.family_relationships FROM app_runtime', cols, cols);
END $$;
GRANT SELECT ON public.care_event_photos TO app_runtime;
GRANT SELECT ON public.care_event_photo_events TO app_runtime;
GRANT INSERT, UPDATE ON public.family_relationships TO app_runtime;

-- M2
DROP POLICY IF EXISTS audit_log_photo_scope ON public.audit_log;
DROP FUNCTION IF EXISTS public.app_is_photo_audit_action(text);

-- H1
DROP FUNCTION IF EXISTS public.app_photo_missing_summary();
DROP FUNCTION IF EXISTS public.app_photo_missing_due(integer);
DROP FUNCTION IF EXISTS public.app_photo_missing_clear(uuid[]);
DROP FUNCTION IF EXISTS public.app_photo_missing_record(uuid[], text);
DROP TABLE IF EXISTS public.photo_missing_findings;
DROP FUNCTION IF EXISTS public.app_photo_bind_storage_identity(uuid, text);
DROP FUNCTION IF EXISTS public.app_photo_storage_identity();
DROP TABLE IF EXISTS public.photo_storage_identity;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.photo_retention_runs WHERE storage_check IS NOT NULL OR reconcile_halted IS NOT NULL OR missing_found <> 0) THEN
    ALTER TABLE public.photo_retention_runs DROP CONSTRAINT IF EXISTS photo_retention_runs_codes_145;
    ALTER TABLE public.photo_retention_runs DROP COLUMN IF EXISTS storage_check, DROP COLUMN IF EXISTS missing_found, DROP COLUMN IF EXISTS reconcile_halted;
  ELSE
    RAISE NOTICE 'photo_retention_runs: 145 columns kept (runs already recorded them)';
  END IF;
END $$;

-- Previous definitions (141 / 143 / 144), verbatim.
CREATE OR REPLACE FUNCTION public.app_photo_hold_active(p_photo_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id
                 AND p.deleted_at IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at > now())
$$;

CREATE OR REPLACE FUNCTION public.app_photo_legal_hold_write(p_photo_id uuid, p_action text, p_text text, p_reference text, p_review_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); p record; v_text text := btrim(coalesce(p_text, ''));
        v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL OR NOT public.app_is_org_admin() THEN
    RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF length(v_text) NOT BETWEEN 10 AND 300 THEN RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_BASIS_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 120 THEN RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_BASIS_REQUIRED' USING ERRCODE = '22023'; END IF;

  IF p_action = 'RELEASE' THEN
    IF p.legal_hold_basis IS NULL THEN RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
    UPDATE public.care_event_photos SET legal_hold_basis = NULL, legal_hold_reference = NULL, legal_hold_by_user_id = NULL,
           legal_hold_placed_at = NULL, legal_hold_review_at = NULL WHERE id = p_photo_id;
  ELSE
    IF p_review_at IS NULL OR p_review_at <= now() OR p_review_at > now() + interval '90 days' THEN
      RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_REVIEW_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'PLACE' THEN
      IF p.legal_hold_basis IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_EXISTS' USING ERRCODE = '23514'; END IF;
      UPDATE public.care_event_photos SET legal_hold_basis = v_text, legal_hold_reference = v_ref, legal_hold_by_user_id = v_user,
             legal_hold_placed_at = now(), legal_hold_review_at = p_review_at WHERE id = p_photo_id;
    ELSIF p_action = 'REVIEW' THEN
      -- Confirms the obligation is still in force; the basis may be updated.
      IF p.legal_hold_basis IS NULL THEN RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
      UPDATE public.care_event_photos SET legal_hold_basis = v_text, legal_hold_reference = coalesce(v_ref, legal_hold_reference),
             legal_hold_by_user_id = v_user, legal_hold_review_at = p_review_at WHERE id = p_photo_id;
    ELSE
      RAISE EXCEPTION 'PHOTO_INVALID_DECISION' USING ERRCODE = '22023';
    END IF;
  END IF;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, actor_user_id, reason)
  VALUES (v_org, p_photo_id, p.care_recipient_id, 'LEGAL_HOLD_' || CASE p_action WHEN 'PLACE' THEN 'PLACED' WHEN 'REVIEW' THEN 'REVIEWED' ELSE 'RELEASED' END,
          p.share_status, p.share_status, v_user,
          left(v_text || coalesce(' [' || v_ref || ']', '')
               || CASE WHEN p_action <> 'RELEASE' THEN ' (revisión: ' || to_char(p_review_at AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD') || ')' ELSE '' END, 500));
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
  VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_LEGAL_HOLD_' || p_action, 'care_event_photo', p_photo_id,
          -- Never the basis or the reference: ETNARA central can read audit_log (platform policy).
          jsonb_build_object('reviewAt', p_review_at, 'hasReference', v_ref IS NOT NULL));
  RETURN p_review_at;
END $$;

CREATE OR REPLACE FUNCTION public.app_activity_photo_for_view(p_photo_id uuid)
RETURNS TABLE (storage_key text, content_type text, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_kind text; p record;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RETURN; END IF;
  IF NOT public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS') THEN RETURN; END IF;
  SELECT cep.id, cep.retention_until, cep.legal_hold_basis, f.storage_key AS key, f.content_type AS ctype, f.size_bytes AS size
    INTO p
    FROM public.care_event_photos cep JOIN public.stored_files f ON f.id = cep.file_id
   WHERE cep.id = p_photo_id AND cep.organization_id = v_org AND cep.deleted_at IS NULL
     AND f.status = 'active' AND f.purpose = 'ACTIVITY_PHOTO';
  IF NOT FOUND THEN RETURN; END IF;
  IF public.app_photo_is_manager() AND (now() < p.retention_until OR public.app_photo_hold_active(p_photo_id) OR p.legal_hold_basis IS NOT NULL) THEN v_kind := 'MANAGER';
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
  IF p.legal_hold_basis IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_ON_LEGAL_HOLD' USING ERRCODE = '23514'; END IF;
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

DROP FUNCTION IF EXISTS public.app_photo_mark_missing(uuid);
CREATE FUNCTION public.app_photo_mark_missing(p_photo_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'gone'; END IF;
  IF p.legal_hold_basis IS NOT NULL THEN RETURN 'legal_hold'; END IF;
  UPDATE public.care_event_photos
     SET share_status = 'deleted', deleted_at = now(), deletion_kind = 'RECONCILED', deletion_reason = 'Archivo inexistente en el almacenamiento',
         hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL,
         purged_at = now(), purge_verified_at = now()
   WHERE id = p_photo_id;
  UPDATE public.stored_files SET status = 'hidden' WHERE id = p.file_id;
  UPDATE public.stored_files SET storage_key = 'purged/' || id, checksum = NULL, size_bytes = 0, original_filename = 'purged' WHERE id = p.file_id;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status)
  VALUES (p.organization_id, p.id, p.care_recipient_id, 'PURGED', 'deleted', 'deleted');
  RETURN 'marked';
END $$;
REVOKE ALL ON FUNCTION public.app_photo_mark_missing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_mark_missing(uuid) TO app_runtime;
CREATE OR REPLACE FUNCTION public.app_photo_record_run(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; pol record;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO pol FROM public.photo_retention_policies WHERE purpose = 'ACTIVITY_PHOTO';
  INSERT INTO public.photo_retention_runs (mode, started_at, policy_status, policy_days, purge_enabled, expired_due, expired_marked, held_skipped,
    holds_lapsed, queue_pending, purged_verified, purge_failed, pending_over_24h, reconciled, orphans_found, orphans_deleted, missing_marked, error_codes,
    legal_held, legal_review_overdue, legal_held_missing)
  VALUES (p->>'mode', (p->>'startedAt')::timestamptz, pol.status, pol.retention_days, pol.purge_enabled,
    coalesce((p->>'expiredDue')::int, 0), coalesce((p->>'expiredMarked')::int, 0), coalesce((p->>'heldSkipped')::int, 0),
    coalesce((p->>'holdsLapsed')::int, 0), coalesce((p->>'queuePending')::int, 0), coalesce((p->>'purgedVerified')::int, 0),
    coalesce((p->>'purgeFailed')::int, 0), coalesce((p->>'pendingOver24h')::int, 0), coalesce((p->>'reconciled')::boolean, false),
    coalesce((p->>'orphansFound')::int, 0), coalesce((p->>'orphansDeleted')::int, 0), coalesce((p->>'missingMarked')::int, 0),
    coalesce(ARRAY(SELECT left(x, 60) FROM jsonb_array_elements_text(coalesce(p->'errorCodes', '[]'::jsonb)) AS x WHERE x ~ '^[A-Za-z0-9_]{1,60}$' LIMIT 20), '{}'),
    coalesce((p->>'legalHeld')::int, 0), coalesce((p->>'legalReviewOverdue')::int, 0), coalesce((p->>'legalHeldMissing')::int, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.app_photo_legal_review_notify()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'America/Puerto_Rico')::date;
  v_total integer := 0;
  v_n integer;
  r record;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  FOR r IN
    SELECT p.organization_id AS org, count(*)::integer AS n
      FROM public.care_event_photos p
     WHERE p.deleted_at IS NULL
       AND p.legal_hold_basis IS NOT NULL
       AND p.legal_hold_review_at <= now()
     GROUP BY p.organization_id
  LOOP
    -- With the switch off the administrative screen is not available (and the
    -- legal-hold actions are refused), so no link can be offered.
    CONTINUE WHEN NOT public.app_org_feature_enabled(r.org, 'ACTIVITY_PHOTOS');
    WITH inserted AS (
      INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id,
                                        care_recipient_id, channel, status, sent_at, item_count, notice_day)
      SELECT DISTINCT om.user_id, r.org, 'PHOTO_LEGAL_HOLD_REVIEW_OVERDUE', 'organization', r.org,
                      NULL::uuid, 'in_app', 'sent', now(), r.n, v_day
        FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN public.roles ro ON ro.id = ur.role_id
        JOIN public.users u ON u.id = om.user_id
       WHERE om.organization_id = r.org AND om.status = 'active' AND u.status = 'active'
         AND ro.code = 'ORGANIZATION_ADMIN'
      ON CONFLICT DO NOTHING
      RETURNING 1)
    SELECT count(*)::integer INTO v_n FROM inserted;
    v_total := v_total + v_n;
  END LOOP;
  RETURN v_total;
END $$;

DELETE FROM schema_migrations WHERE filename = '145_activity_photos_hardening.sql';
COMMIT;

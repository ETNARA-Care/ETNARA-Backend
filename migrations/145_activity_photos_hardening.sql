-- Migration 145: activity photos v2 — security hardening after the 2-nov audit.
-- Rafa (3-nov-2026): local development only, synthetic data, nothing activated.
--
--  H1  The weekly reconciliation no longer tombstones a photo just because its
--      file answers 404. The storage must first prove it is the RIGHT bucket
--      (an identity marker bound once, while no live photo exists), a missing
--      file becomes a FINDING that must be seen again in a later run (>= 24 h)
--      and is never tombstoned while the policy is PROVISIONAL, under an
--      ordinary hold in force or under a legal hold. The job (code) stops the
--      whole reconciliation on storage errors or anomalous volumes.
--  M1  A caregiver removing a photo the agency keeps gets one code,
--      PHOTO_KEPT_BY_AGENCY (never which kind of hold).
--  M2  audit_log: ETNARA central no longer reads photo / consent / relative's
--      authorization actions; legal-hold actions only for the agency's admins.
--  M3  family_relationships.photo_receipt(_at): app_runtime loses INSERT and
--      UPDATE on those two columns (column privileges are checked by
--      PostgreSQL before any trigger: a session variable cannot bypass them).
--      Only the relative's SECURITY DEFINER function writes them.
--  M4  care_event_photos: hold_reason, legal_hold_basis, legal_hold_reference,
--      legal_hold_by_user_id, review_reason and deletion_reason are no longer
--      readable by app_runtime; care_event_photo_events.reason neither. Managers
--      read them through functions; legal fields only for ORGANIZATION_ADMIN (§6).
--  L1  app_photo_created_summary: the upload reads back its own new photo
--      without RLS (a late upload no longer answers 500).
--  I2  app_photo_hold_active checks the agency.
--  §4  Agencies without an active administrator: one notice per episode (after
--      24 h) to the agency's active supervisors and to ETNARA central. Never a
--      word about photos or legal holds.
--  §5  ACTIVITY_PHOTOS off: legal-review-only mode for ORGANIZATION_ADMIN
--      (review / release, view a held image with an audit row); the daily
--      legal-review notice keeps running; central can only learn THAT some
--      legal hold exists (one boolean), never how many or which.
--
-- Additive: two owner-only tables, new columns on the run log, privileges and
-- function redefinitions. Reversal: ops/145_activity_photos_hardening.rollback.sql.

-- ==================================================================== H1: storage identity
CREATE TABLE IF NOT EXISTS photo_storage_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  marker    uuid NOT NULL,
  bound_at  timestamptz NOT NULL DEFAULT now(),
  bound_by  text NOT NULL CHECK (bound_by IN ('job', 'startup', 'operator'))
);
DROP TRIGGER IF EXISTS photo_storage_identity_append_only ON photo_storage_identity;
CREATE TRIGGER photo_storage_identity_append_only BEFORE UPDATE OR DELETE ON photo_storage_identity
  FOR EACH ROW EXECUTE FUNCTION public.app_append_only_141();
ALTER TABLE photo_storage_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_storage_identity FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_storage_identity FROM app_runtime;
DROP POLICY IF EXISTS photo_storage_identity_owner ON photo_storage_identity;
CREATE POLICY photo_storage_identity_owner ON photo_storage_identity FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

-- Marker (if bound) and how many live photos the database knows (job only).
CREATE OR REPLACE FUNCTION public.app_photo_storage_identity()
RETURNS TABLE (marker uuid, live_photos integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY SELECT (SELECT i.marker FROM public.photo_storage_identity i),
                      (SELECT count(*)::int FROM public.care_event_photos p WHERE p.deleted_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.app_photo_storage_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_storage_identity() TO app_runtime;

-- Binds the marker once, and only while no live photo exists (a wrong bucket
-- can never be bound over real photos). Anything else is an operator decision.
CREATE OR REPLACE FUNCTION public.app_photo_bind_storage_identity(p_marker uuid, p_by text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  IF p_marker IS NULL OR p_by NOT IN ('job', 'startup') THEN RAISE EXCEPTION 'PHOTO_STORAGE_IDENTITY_INVALID' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('photo-storage-identity', 0));
  IF EXISTS (SELECT 1 FROM public.photo_storage_identity) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.deleted_at IS NULL) THEN RETURN false; END IF;
  INSERT INTO public.photo_storage_identity (marker, bound_by) VALUES (p_marker, p_by);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_bind_storage_identity(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_bind_storage_identity(uuid, text) TO app_runtime;

-- ==================================================================== H1: missing-file findings
CREATE TABLE IF NOT EXISTS photo_missing_findings (
  photo_id        uuid PRIMARY KEY REFERENCES care_event_photos(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  times_seen      integer NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reappeared', 'tombstoned')),
  last_outcome    text NULL CHECK (last_outcome IS NULL OR last_outcome IN
                    ('policy_provisional', 'not_confirmed', 'held', 'legal_hold', 'marked', 'halted')),
  resolved_at     timestamptz NULL
);
ALTER TABLE photo_missing_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_missing_findings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_missing_findings FROM app_runtime;
DROP POLICY IF EXISTS photo_missing_findings_owner ON photo_missing_findings;
CREATE POLICY photo_missing_findings_owner ON photo_missing_findings FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

-- Records (or re-confirms) live photos whose file answered a verified 404 in this run.
-- A second sighting counts only if the previous one is >= 12 h old (separate runs).
CREATE OR REPLACE FUNCTION public.app_photo_missing_record(p_ids uuid[], p_outcome text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  PERFORM public.app_photo_job_guard();
  IF coalesce(array_length(p_ids, 1), 0) > 1000 THEN RAISE EXCEPTION 'PHOTO_JOB_BATCH_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('policy_provisional', 'not_confirmed', 'halted') THEN
    RAISE EXCEPTION 'PHOTO_JOB_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.photo_missing_findings AS f (photo_id, organization_id, last_outcome)
  SELECT p.id, p.organization_id, p_outcome FROM public.care_event_photos p
   WHERE p.id = ANY (coalesce(p_ids, '{}')) AND p.deleted_at IS NULL
  ON CONFLICT (photo_id) DO UPDATE SET
    first_seen_at = CASE WHEN f.status = 'open' THEN f.first_seen_at ELSE now() END,
    times_seen    = CASE WHEN f.status <> 'open' THEN 1
                         WHEN f.last_seen_at <= now() - interval '12 hours' THEN f.times_seen + 1 ELSE f.times_seen END,
    last_seen_at  = now(), status = 'open', resolved_at = NULL, last_outcome = EXCLUDED.last_outcome;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_missing_record(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_missing_record(uuid[], text) TO app_runtime;

-- Files present again (e.g. a bucket restored): open findings are closed, nothing else changes.
CREATE OR REPLACE FUNCTION public.app_photo_missing_clear(p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  PERFORM public.app_photo_job_guard();
  IF coalesce(array_length(p_ids, 1), 0) > 1000 THEN RAISE EXCEPTION 'PHOTO_JOB_BATCH_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  UPDATE public.photo_missing_findings SET status = 'reappeared', resolved_at = now()
   WHERE photo_id = ANY (coalesce(p_ids, '{}')) AND status = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_missing_clear(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_missing_clear(uuid[]) TO app_runtime;

-- Open findings old enough to be decided on (seen in >= 2 runs, first >= 24 h ago).
CREATE OR REPLACE FUNCTION public.app_photo_missing_due(p_limit integer)
RETURNS TABLE (photo_id uuid, storage_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY
    SELECT f.photo_id, sf.storage_key FROM public.photo_missing_findings f
      JOIN public.care_event_photos p ON p.id = f.photo_id JOIN public.stored_files sf ON sf.id = p.file_id
     WHERE f.status = 'open' AND f.times_seen >= 2 AND f.first_seen_at <= now() - interval '24 hours' AND p.deleted_at IS NULL
     ORDER BY f.first_seen_at LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END $$;
REVOKE ALL ON FUNCTION public.app_photo_missing_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_missing_due(integer) TO app_runtime;

-- Open findings, for the run log and the alerts (counts only).
CREATE OR REPLACE FUNCTION public.app_photo_missing_summary()
RETURNS TABLE (open_findings integer, open_legal_hold integer, open_held integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY SELECT count(*)::int,
                      (count(*) FILTER (WHERE p.legal_hold_basis IS NOT NULL))::int,
                      (count(*) FILTER (WHERE p.legal_hold_basis IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at > now()))::int
                 FROM public.photo_missing_findings f JOIN public.care_event_photos p ON p.id = f.photo_id
                WHERE f.status = 'open' AND p.deleted_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_missing_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_missing_summary() TO app_runtime;

-- Tombstone a confirmed missing file. Every condition is re-checked here, under a row lock.
DROP FUNCTION IF EXISTS public.app_photo_mark_missing(uuid);
CREATE FUNCTION public.app_photo_mark_missing(p_photo_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record; f record; pol record;
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'gone'; END IF;
  SELECT * INTO f FROM public.photo_missing_findings WHERE photo_id = p_photo_id FOR UPDATE;
  SELECT * INTO pol FROM public.photo_retention_policies WHERE purpose = 'ACTIVITY_PHOTO';
  IF p.legal_hold_basis IS NOT NULL THEN
    UPDATE public.photo_missing_findings SET last_outcome = 'legal_hold' WHERE photo_id = p_photo_id;
    RETURN 'legal_hold';
  END IF;
  IF pol IS NULL OR pol.status <> 'APPROVED' OR NOT pol.purge_enabled THEN
    UPDATE public.photo_missing_findings SET last_outcome = 'policy_provisional' WHERE photo_id = p_photo_id;
    RETURN 'policy_provisional';
  END IF;
  IF f IS NULL OR f.status <> 'open' OR f.times_seen < 2 OR f.first_seen_at > now() - interval '24 hours' THEN
    UPDATE public.photo_missing_findings SET last_outcome = 'not_confirmed' WHERE photo_id = p_photo_id;
    RETURN 'not_confirmed';
  END IF;
  IF p.hold_reason IS NOT NULL AND p.hold_review_at > now() THEN
    UPDATE public.photo_missing_findings SET last_outcome = 'held' WHERE photo_id = p_photo_id;
    RETURN 'held';
  END IF;
  UPDATE public.care_event_photos
     SET share_status = 'deleted', deleted_at = now(), deletion_kind = 'RECONCILED', deletion_reason = 'Archivo inexistente en el almacenamiento',
         hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL,
         purged_at = now(), purge_verified_at = now()
   WHERE id = p_photo_id;
  UPDATE public.stored_files SET status = 'hidden' WHERE id = p.file_id;
  UPDATE public.stored_files SET storage_key = 'purged/' || id, checksum = NULL, size_bytes = 0, original_filename = 'purged' WHERE id = p.file_id;
  INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status)
  VALUES (p.organization_id, p.id, p.care_recipient_id, 'PURGED', 'deleted', 'deleted');
  UPDATE public.photo_missing_findings SET status = 'tombstoned', resolved_at = now(), last_outcome = 'marked' WHERE photo_id = p_photo_id;
  RETURN 'marked';
END $$;
REVOKE ALL ON FUNCTION public.app_photo_mark_missing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_mark_missing(uuid) TO app_runtime;

-- Run log: storage check result, what reconciliation found and why it stopped.
ALTER TABLE photo_retention_runs ADD COLUMN IF NOT EXISTS storage_check text NULL;
ALTER TABLE photo_retention_runs ADD COLUMN IF NOT EXISTS missing_found integer NOT NULL DEFAULT 0;
ALTER TABLE photo_retention_runs ADD COLUMN IF NOT EXISTS reconcile_halted text NULL;
ALTER TABLE photo_retention_runs DROP CONSTRAINT IF EXISTS photo_retention_runs_codes_145;
ALTER TABLE photo_retention_runs ADD CONSTRAINT photo_retention_runs_codes_145 CHECK (
  (storage_check IS NULL OR storage_check ~ '^[A-Z_]{1,60}$') AND (reconcile_halted IS NULL OR reconcile_halted ~ '^[A-Z_]{1,60}$'));

CREATE OR REPLACE FUNCTION public.app_photo_record_run(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; pol record;
  code_or_null CONSTANT text := '^[A-Z_]{1,60}$';
BEGIN
  PERFORM public.app_photo_job_guard();
  SELECT * INTO pol FROM public.photo_retention_policies WHERE purpose = 'ACTIVITY_PHOTO';
  INSERT INTO public.photo_retention_runs (mode, started_at, policy_status, policy_days, purge_enabled, expired_due, expired_marked, held_skipped,
    holds_lapsed, queue_pending, purged_verified, purge_failed, pending_over_24h, reconciled, orphans_found, orphans_deleted, missing_marked, error_codes,
    legal_held, legal_review_overdue, legal_held_missing, storage_check, missing_found, reconcile_halted)
  VALUES (p->>'mode', (p->>'startedAt')::timestamptz, pol.status, pol.retention_days, pol.purge_enabled,
    coalesce((p->>'expiredDue')::int, 0), coalesce((p->>'expiredMarked')::int, 0), coalesce((p->>'heldSkipped')::int, 0),
    coalesce((p->>'holdsLapsed')::int, 0), coalesce((p->>'queuePending')::int, 0), coalesce((p->>'purgedVerified')::int, 0),
    coalesce((p->>'purgeFailed')::int, 0), coalesce((p->>'pendingOver24h')::int, 0), coalesce((p->>'reconciled')::boolean, false),
    coalesce((p->>'orphansFound')::int, 0), coalesce((p->>'orphansDeleted')::int, 0), coalesce((p->>'missingMarked')::int, 0),
    coalesce(ARRAY(SELECT left(x, 60) FROM jsonb_array_elements_text(coalesce(p->'errorCodes', '[]'::jsonb)) AS x WHERE x ~ '^[A-Za-z0-9_]{1,60}$' LIMIT 20), '{}'),
    coalesce((p->>'legalHeld')::int, 0), coalesce((p->>'legalReviewOverdue')::int, 0), coalesce((p->>'legalHeldMissing')::int, 0),
    CASE WHEN p->>'storageCheck' ~ code_or_null THEN p->>'storageCheck' END,
    coalesce((p->>'missingFound')::int, 0),
    CASE WHEN p->>'reconcileHalted' ~ code_or_null THEN p->>'reconcileHalted' END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_record_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_record_run(jsonb) TO app_runtime;

-- ==================================================================== I2: holds are per agency
CREATE OR REPLACE FUNCTION public.app_photo_hold_active(p_photo_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id
                 AND p.organization_id = public.app_photo_ctx_org()
                 AND p.deleted_at IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at > now())
$$;

-- ==================================================================== M1 + D1: one answer for the caregiver
-- Whether the agency keeps this photo (any hold in force). Yes/no only, own agency only.
CREATE OR REPLACE FUNCTION public.app_photo_kept_by_agency(p_photo_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT public.app_is_superadmin() AND EXISTS (
    SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id AND p.organization_id = public.app_photo_ctx_org()
       AND p.deleted_at IS NULL
       AND (p.legal_hold_basis IS NOT NULL OR (p.hold_reason IS NOT NULL AND p.hold_review_at > now())))
$$;
REVOKE ALL ON FUNCTION public.app_photo_kept_by_agency(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_kept_by_agency(uuid) TO app_runtime;

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
  -- M1: the caregiver never learns which kind of hold (or that a legal obligation exists).
  IF v_kind = 'CAREGIVER_UNDO' AND (p.legal_hold_basis IS NOT NULL OR (p.hold_reason IS NOT NULL AND p.hold_review_at > now())) THEN
    RAISE EXCEPTION 'PHOTO_KEPT_BY_AGENCY' USING ERRCODE = '23514';
  END IF;
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
REVOKE ALL ON FUNCTION public.app_delete_activity_photo(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_delete_activity_photo(uuid, text) TO app_runtime;

-- ==================================================================== L1: read back a just-created photo
CREATE OR REPLACE FUNCTION public.app_photo_created_summary(p_photo_id uuid)
RETURNS TABLE (share_status text, retention_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  -- Only the photo this user created in THIS transaction (created_at = now()).
  SELECT p.share_status, p.retention_until FROM public.care_event_photos p
   WHERE p.id = p_photo_id AND p.organization_id = public.app_photo_ctx_org()
     AND p.uploaded_by_user_id = public.app_photo_ctx_user() AND p.created_at = now() AND NOT public.app_is_superadmin()
$$;
REVOKE ALL ON FUNCTION public.app_photo_created_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_created_summary(uuid) TO app_runtime;

-- ==================================================================== M2: audit_log scope
CREATE OR REPLACE FUNCTION public.app_is_photo_audit_action(p_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT p_action LIKE 'ACTIVITY\_PHOTO\_%' OR p_action LIKE 'PHOTO\_%'
$$;
REVOKE ALL ON FUNCTION public.app_is_photo_audit_action(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_photo_audit_action(text) TO app_runtime;

DROP POLICY IF EXISTS audit_log_photo_scope ON audit_log;
CREATE POLICY audit_log_photo_scope ON audit_log
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (NOT public.app_is_photo_audit_action(action)
         OR (NOT app_is_superadmin()
             AND (action NOT LIKE 'ACTIVITY\_PHOTO\_LEGAL\_HOLD\_%' OR public.app_is_org_admin())));

-- ==================================================================== M3: relative's authorization columns
REVOKE INSERT, UPDATE ON public.family_relationships FROM app_runtime;
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = 'public.family_relationships'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('photo_receipt', 'photo_receipt_at');
  EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON public.family_relationships TO app_runtime', cols, cols);
END $$;

-- ==================================================================== M4 + §6: confidential columns
REVOKE SELECT ON public.care_event_photos FROM app_runtime;
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = 'public.care_event_photos'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('hold_reason', 'legal_hold_basis', 'legal_hold_reference', 'legal_hold_by_user_id', 'review_reason', 'deletion_reason');
  EXECUTE format('GRANT SELECT (%s) ON public.care_event_photos TO app_runtime', cols);
END $$;
REVOKE SELECT ON public.care_event_photo_events FROM app_runtime;
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = 'public.care_event_photo_events'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname <> 'reason';
  EXECUTE format('GRANT SELECT (%s) ON public.care_event_photo_events TO app_runtime', cols);
END $$;

-- What the agency's photo screens may show. Mode for this person in this agency:
--  'full'          ACTIVITY_PHOTOS on and manager (administration or supervision);
--  'legal-review'  ACTIVITY_PHOTOS off, ORGANIZATION_ADMIN, and some photo is under a legal hold;
--  'off'           anything else.
CREATE OR REPLACE FUNCTION public.app_photo_agency_mode() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN public.app_is_superadmin() OR public.app_photo_ctx_org() IS NULL OR public.app_photo_ctx_user() IS NULL THEN 'off'
    WHEN public.app_org_feature_enabled(public.app_photo_ctx_org(), 'ACTIVITY_PHOTOS') THEN
      CASE WHEN public.app_photo_is_manager() THEN 'full' ELSE 'off' END
    WHEN public.app_is_org_admin() AND EXISTS (SELECT 1 FROM public.care_event_photos p
           WHERE p.organization_id = public.app_photo_ctx_org() AND p.deleted_at IS NULL AND p.legal_hold_basis IS NOT NULL) THEN 'legal-review'
    ELSE 'off' END
$$;
REVOKE ALL ON FUNCTION public.app_photo_agency_mode() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_agency_mode() TO app_runtime;

-- Free-text fields for the agency's list. Manager only. Legal basis, reference and
-- who placed it: ORGANIZATION_ADMIN only (§6). In 'legal-review' mode only held photos.
CREATE OR REPLACE FUNCTION public.app_photo_confidential(p_ids uuid[])
RETURNS TABLE (photo_id uuid, review_reason text, deletion_reason text, hold_reason text,
               legal_hold_basis text, legal_hold_reference text, legal_hold_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_mode text := public.app_photo_agency_mode(); v_admin boolean := public.app_is_org_admin();
BEGIN
  IF v_mode = 'off' THEN
    IF public.app_org_feature_enabled(public.app_photo_ctx_org(), 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
    RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_ids, 1), 0) > 200 THEN RAISE EXCEPTION 'PHOTO_JOB_BATCH_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
    SELECT p.id, p.review_reason, p.deletion_reason, p.hold_reason,
           CASE WHEN v_admin THEN p.legal_hold_basis END,
           CASE WHEN v_admin THEN p.legal_hold_reference END,
           CASE WHEN v_admin THEN u.email::text END
      FROM public.care_event_photos p LEFT JOIN public.users u ON u.id = p.legal_hold_by_user_id
     WHERE p.id = ANY (coalesce(p_ids, '{}')) AND p.organization_id = public.app_photo_ctx_org()
       AND (v_mode = 'full' OR p.legal_hold_basis IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.app_photo_confidential(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_confidential(uuid[]) TO app_runtime;

-- A photo's history. Manager only; the text of legal-hold entries (basis and
-- reference) only for ORGANIZATION_ADMIN (§6). In 'legal-review' mode only held photos.
DROP FUNCTION IF EXISTS public.app_photo_history(uuid);
CREATE FUNCTION public.app_photo_history(p_photo_id uuid)
RETURNS TABLE (event_id uuid, action text, from_status text, to_status text, reason text, occurred_at timestamptz, actor_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_mode text := public.app_photo_agency_mode(); v_admin boolean := public.app_is_org_admin();
BEGIN
  IF v_mode = 'off' THEN
    IF public.app_org_feature_enabled(public.app_photo_ctx_org(), 'ACTIVITY_PHOTOS') THEN RAISE EXCEPTION 'PHOTO_REVIEW_MANAGER_ONLY' USING ERRCODE = '42501'; END IF;
    RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF v_mode = 'legal-review' AND NOT EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.id = p_photo_id
       AND p.organization_id = public.app_photo_ctx_org() AND p.deleted_at IS NULL AND p.legal_hold_basis IS NOT NULL) THEN
    RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e.id, e.action, e.from_status, e.to_status,
           CASE WHEN e.action LIKE 'LEGAL\_HOLD\_%' AND NOT v_admin THEN NULL ELSE e.reason END,
           e.occurred_at, e.actor_user_id
      FROM public.care_event_photo_events e
     WHERE e.photo_id = p_photo_id AND e.organization_id = public.app_photo_ctx_org()
     ORDER BY e.occurred_at, (e.action <> 'UPLOADED'), e.id;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_history(uuid) TO app_runtime;

-- ==================================================================== §5: legal review with the switch off
-- PLACE needs the switch on; REVIEW and RELEASE never depend on it (an obligation
-- in force must stay reviewable whatever the agency's modules).
CREATE OR REPLACE FUNCTION public.app_photo_legal_hold_write(p_photo_id uuid, p_action text, p_text text, p_reference text, p_review_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); p record; v_text text := btrim(coalesce(p_text, ''));
        v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_on boolean;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL OR NOT public.app_is_org_admin() THEN
    RAISE EXCEPTION 'PHOTO_LEGAL_HOLD_ADMIN_ONLY' USING ERRCODE = '42501';
  END IF;
  v_on := public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS');
  IF NOT v_on AND p_action NOT IN ('REVIEW', 'RELEASE') THEN RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.care_event_photos WHERE id = p_photo_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
  IF NOT v_on AND p.legal_hold_basis IS NULL THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND' USING ERRCODE = '42501'; END IF;
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
          jsonb_build_object('reviewAt', p_review_at, 'hasReference', v_ref IS NOT NULL, 'moduleOn', v_on));
  RETURN p_review_at;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_legal_hold_write(uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_legal_hold_write(uuid, text, text, text, timestamptz) TO app_runtime;

-- Viewing. Switch off: only an ORGANIZATION_ADMIN, only a photo under a legal hold.
-- Every view of a photo under a legal hold by agency staff leaves an audit row.
CREATE OR REPLACE FUNCTION public.app_activity_photo_for_view(p_photo_id uuid)
RETURNS TABLE (storage_key text, content_type text, size_bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.app_photo_ctx_org(); v_user uuid := public.app_photo_ctx_user(); v_kind text; p record; v_on boolean;
BEGIN
  IF public.app_is_superadmin() OR v_org IS NULL OR v_user IS NULL THEN RETURN; END IF;
  v_on := public.app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS');
  SELECT cep.id, cep.retention_until, cep.legal_hold_basis, f.storage_key AS key, f.content_type AS ctype, f.size_bytes AS size
    INTO p
    FROM public.care_event_photos cep JOIN public.stored_files f ON f.id = cep.file_id
   WHERE cep.id = p_photo_id AND cep.organization_id = v_org AND cep.deleted_at IS NULL
     AND f.status = 'active' AND f.purpose = 'ACTIVITY_PHOTO';
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT v_on THEN
    IF NOT (public.app_is_org_admin() AND p.legal_hold_basis IS NOT NULL) THEN RETURN; END IF;
    v_kind := 'LEGAL_REVIEW';
  ELSIF public.app_photo_is_manager() AND (now() < p.retention_until OR public.app_photo_hold_active(p_photo_id) OR p.legal_hold_basis IS NOT NULL) THEN v_kind := 'MANAGER';
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
  IF v_kind IN ('MANAGER', 'LEGAL_REVIEW') AND p.legal_hold_basis IS NOT NULL THEN
    INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
    VALUES (v_user, v_org, v_org, 'ACTIVITY_PHOTO_LEGAL_HOLD_VIEWED', 'care_event_photo', p_photo_id,
            jsonb_build_object('mode', CASE v_kind WHEN 'LEGAL_REVIEW' THEN 'legal-review' ELSE 'full' END));
  END IF;
  storage_key := p.key; content_type := p.ctype; size_bytes := p.size;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.app_activity_photo_for_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_activity_photo_for_view(uuid) TO app_runtime;

-- The daily legal-review notice keeps running with the switch off (144 skipped those agencies).
CREATE OR REPLACE FUNCTION public.app_photo_legal_review_notify()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
     WHERE p.deleted_at IS NULL AND p.legal_hold_basis IS NOT NULL AND p.legal_hold_review_at <= now()
     GROUP BY p.organization_id
  LOOP
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
REVOKE ALL ON FUNCTION public.app_photo_legal_review_notify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_legal_review_notify() TO app_runtime;

-- ETNARA central, when switching the module: whether ANY photo of the agency is
-- under a legal hold. One boolean: never how many, which, or why.
CREATE OR REPLACE FUNCTION public.app_platform_org_has_legal_holds(p_org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.app_is_superadmin() THEN RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN EXISTS (SELECT 1 FROM public.care_event_photos p WHERE p.organization_id = p_org AND p.deleted_at IS NULL AND p.legal_hold_basis IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.app_platform_org_has_legal_holds(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_org_has_legal_holds(uuid) TO app_runtime;

-- ==================================================================== §4: agencies without an active administrator
-- An "active administrator": ORGANIZATION_ADMIN role, active membership, active
-- user. Disabled accounts, revoked memberships and invitations not yet accepted
-- (membership 'invited') do not count.
CREATE OR REPLACE FUNCTION public.app_org_has_active_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_memberships om
                   JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                   JOIN public.roles ro ON ro.id = ur.role_id
                   JOIN public.users u ON u.id = om.user_id
                  WHERE om.organization_id = p_org AND om.status = 'active' AND u.status = 'active' AND ro.code = 'ORGANIZATION_ADMIN')
$$;
REVOKE ALL ON FUNCTION public.app_org_has_active_admin(uuid) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS organization_admin_gaps (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  since           timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz NULL
);
ALTER TABLE organization_admin_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_admin_gaps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON organization_admin_gaps FROM app_runtime;
DROP POLICY IF EXISTS organization_admin_gaps_owner ON organization_admin_gaps;
CREATE POLICY organization_admin_gaps_owner ON organization_admin_gaps FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_admin_gap_shape;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_admin_gap_shape CHECK (
  notification_type NOT IN ('AGENCY_NO_ACTIVE_ADMIN', 'PLATFORM_AGENCY_NO_ACTIVE_ADMIN')
  OR (organization_id IS NOT NULL AND related_entity_type = 'organization' AND related_entity_id = organization_id
      AND care_recipient_id IS NULL AND channel = 'in_app'));
-- At most one unread notice per person, agency and kind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_admin_gap_unread
  ON public.notifications (user_id, organization_id, notification_type)
  WHERE notification_type IN ('AGENCY_NO_ACTIVE_ADMIN', 'PLATFORM_AGENCY_NO_ACTIVE_ADMIN') AND read_at IS NULL;

/**
 * Background job only. Opens an episode when an active agency has no active
 * administrator, closes it when one is back, and after 24 h notifies ONCE per
 * episode: the agency's active supervisors (their own agency) and ETNARA
 * central (which agency). Returns how many notices were created.
 */
CREATE OR REPLACE FUNCTION public.app_org_admin_gap_notify()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_total integer := 0; v_n integer; r record;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('org-admin-gap', 0));
  -- Episodes that ended (an administrator is back, or the agency is no longer active).
  DELETE FROM public.organization_admin_gaps g
   WHERE public.app_org_has_active_admin(g.organization_id)
      OR NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = g.organization_id AND o.status IN ('trial', 'active') AND o.archived_at IS NULL);
  INSERT INTO public.organization_admin_gaps (organization_id)
  SELECT o.id FROM public.organizations o
   WHERE o.status IN ('trial', 'active') AND o.archived_at IS NULL AND NOT public.app_org_has_active_admin(o.id)
  ON CONFLICT (organization_id) DO NOTHING;
  FOR r IN SELECT g.organization_id AS org FROM public.organization_admin_gaps g
            WHERE g.notified_at IS NULL AND g.since <= now() - interval '24 hours' FOR UPDATE LOOP
    WITH inserted AS (
      INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id,
                                        care_recipient_id, channel, status, sent_at)
      SELECT DISTINCT om.user_id, r.org, 'AGENCY_NO_ACTIVE_ADMIN', 'organization', r.org, NULL::uuid, 'in_app', 'sent', now()
        FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN public.roles ro ON ro.id = ur.role_id
        JOIN public.users u ON u.id = om.user_id
       WHERE om.organization_id = r.org AND om.status = 'active' AND u.status = 'active' AND ro.code = 'SUPERVISOR'
      UNION
      SELECT pa.user_id, r.org, 'PLATFORM_AGENCY_NO_ACTIVE_ADMIN', 'organization', r.org, NULL::uuid, 'in_app', 'sent', now()
        FROM public.platform_admins pa JOIN public.users u ON u.id = pa.user_id
       WHERE pa.revoked_at IS NULL AND u.status = 'active'
      ON CONFLICT DO NOTHING
      RETURNING 1)
    SELECT count(*)::integer INTO v_n FROM inserted;
    UPDATE public.organization_admin_gaps SET notified_at = now() WHERE organization_id = r.org;
    v_total := v_total + v_n;
  END LOOP;
  RETURN v_total;
END $$;
REVOKE ALL ON FUNCTION public.app_org_admin_gap_notify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_org_admin_gap_notify() TO app_runtime;

-- The name of the agency in ETNARA central's notice (central already lists agencies by name).
CREATE OR REPLACE FUNCTION public.app_notification_org_name(p_notification_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.name FROM public.notifications n JOIN public.organizations o ON o.id = n.organization_id
   WHERE n.id = p_notification_id AND n.notification_type = 'PLATFORM_AGENCY_NO_ACTIVE_ADMIN'
     AND n.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION public.app_notification_org_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_notification_org_name(uuid) TO app_runtime;

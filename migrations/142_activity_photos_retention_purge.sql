-- Migration 142: activity photos v2 — V2: expiry, purge retries, lapsed holds,
-- reconciliation and a run log, for a periodic job that runs INSIDE the backend
-- as app_runtime WITHOUT a tenant context.
--
-- Safety (2-nov-2026, Rafa):
--  * The 30 days stay PROVISIONAL. Marking an expired photo for deletion
--    (deletion_kind RETENTION) is refused by the database unless the policy is
--    APPROVED and purge_enabled (142 never changes the policy). The backend job
--    also has its own switch PHOTO_RETENTION_JOB = off (default) | simulate | on.
--  * Expiry already cuts access (141). This only removes files.
--  * Visit end, end of the care relationship and revocations never delete.
--  * A hold in force is never purged; a lapsed hold is recorded (HOLD_EXPIRED).
--  * Retries finish deletions a person already decided (MANUAL, CAREGIVER_UNDO);
--    they also run only with the job in "on".
--  * Every job function refuses a call made with a tenant context (requests),
--    and ETNARA central. No storage key leaves these functions except to the
--    job that deletes it; the run log keeps counts only.

-- ---------------------------------------------------------------- run log (counts only, never keys)
CREATE TABLE IF NOT EXISTS photo_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('simulate', 'on')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  policy_status text NOT NULL,
  policy_days integer NOT NULL,
  purge_enabled boolean NOT NULL,
  expired_due integer NOT NULL DEFAULT 0,
  expired_marked integer NOT NULL DEFAULT 0,
  held_skipped integer NOT NULL DEFAULT 0,
  holds_lapsed integer NOT NULL DEFAULT 0,
  queue_pending integer NOT NULL DEFAULT 0,
  purged_verified integer NOT NULL DEFAULT 0,
  purge_failed integer NOT NULL DEFAULT 0,
  pending_over_24h integer NOT NULL DEFAULT 0,
  reconciled boolean NOT NULL DEFAULT false,
  orphans_found integer NOT NULL DEFAULT 0,
  orphans_deleted integer NOT NULL DEFAULT 0,
  missing_marked integer NOT NULL DEFAULT 0,
  error_codes text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_photo_retention_runs_started ON photo_retention_runs (started_at DESC);
DROP TRIGGER IF EXISTS photo_retention_runs_append_only ON photo_retention_runs;
CREATE TRIGGER photo_retention_runs_append_only BEFORE UPDATE OR DELETE ON photo_retention_runs
  FOR EACH ROW EXECUTE FUNCTION public.app_append_only_141();
ALTER TABLE photo_retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_retention_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_retention_runs FROM app_runtime;
DROP POLICY IF EXISTS photo_retention_runs_owner ON photo_retention_runs;
CREATE POLICY photo_retention_runs_owner ON photo_retention_runs FOR ALL TO PUBLIC
  USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

-- Job functions refuse anything that carries a request's tenant context.
CREATE OR REPLACE FUNCTION public.app_photo_job_guard() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF public.app_is_superadmin() OR public.app_photo_ctx_org() IS NOT NULL OR public.app_photo_ctx_user() IS NOT NULL THEN
    RAISE EXCEPTION 'PHOTO_JOB_ONLY' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_job_guard() FROM PUBLIC;

-- The policy as the job sees it (no other data).
CREATE OR REPLACE FUNCTION public.app_photo_retention_policy_state()
RETURNS TABLE (status text, retention_days integer, purge_enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY SELECT p.status, p.retention_days, p.purge_enabled FROM public.photo_retention_policies p WHERE p.purpose = 'ACTIVITY_PHOTO';
END $$;
REVOKE ALL ON FUNCTION public.app_photo_retention_policy_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_retention_policy_state() TO app_runtime;

-- ---------------------------------------------------------------- expiry
-- Counts (simulation and real): expired and not removed; split by holds in force.
CREATE OR REPLACE FUNCTION public.app_photo_retention_counts()
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

-- Lapsed holds: recorded once (HOLD_EXPIRED) and cleared. The 270-day counters stay.
CREATE OR REPLACE FUNCTION public.app_photo_record_lapsed_holds(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n integer := 0;
BEGIN
  PERFORM public.app_photo_job_guard();
  FOR r IN SELECT p.id, p.organization_id, p.care_recipient_id, p.share_status, p.hold_review_at FROM public.care_event_photos p
            WHERE p.deleted_at IS NULL AND p.hold_reason IS NOT NULL AND p.hold_review_at <= now()
            ORDER BY p.hold_review_at LIMIT greatest(1, least(coalesce(p_limit, 100), 500)) FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.care_event_photos SET hold_reason = NULL, hold_by_user_id = NULL, hold_placed_at = NULL, hold_review_at = NULL WHERE id = r.id;
    INSERT INTO public.care_event_photo_events (organization_id, photo_id, care_recipient_id, action, from_status, to_status, reason)
    VALUES (r.organization_id, r.id, r.care_recipient_id, 'HOLD_EXPIRED', r.share_status, r.share_status,
            'Revisión vencida sin renovar: ' || to_char(r.hold_review_at AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD'));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_record_lapsed_holds(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_record_lapsed_holds(integer) TO app_runtime;

-- Mark expired photos for deletion (RETENTION). Refused unless the policy is
-- APPROVED with purge enabled: the 30 provisional days never delete anything.
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
REVOKE ALL ON FUNCTION public.app_photo_mark_expired(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_mark_expired(integer) TO app_runtime;

-- ---------------------------------------------------------------- purge queue (retries with back-off)
-- Next items to purge: not yet done, below the attempt limit, past their back-off
-- (2^attempts minutes, at most 6 h). Claimed atomically. Returns the key to the job only.
CREATE OR REPLACE FUNCTION public.app_photo_purge_next(p_limit integer)
RETURNS TABLE (photo_id uuid, storage_key text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY
  WITH due AS (
    SELECT q.photo_id FROM public.photo_purge_queue q
     WHERE q.purged_at IS NULL AND q.attempts < 20
       AND (q.last_attempt_at IS NULL OR q.last_attempt_at <= now() - least(interval '6 hours', make_interval(mins => (2 ^ least(q.attempts, 9))::int)))
     ORDER BY q.enqueued_at LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) FOR UPDATE SKIP LOCKED)
  UPDATE public.photo_purge_queue q SET attempts = q.attempts + 1, last_attempt_at = now()
    FROM due WHERE q.photo_id = due.photo_id
  RETURNING q.photo_id, q.storage_key, q.attempts;
END $$;
REVOKE ALL ON FUNCTION public.app_photo_purge_next(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_purge_next(integer) TO app_runtime;

-- ---------------------------------------------------------------- reconciliation (weekly)
-- Classifies storage keys listed from the bucket: 'active' (a live photo row),
-- 'queued' (removal pending), or 'unknown' (no row: orphan). Never returns more.
CREATE OR REPLACE FUNCTION public.app_photo_classify_keys(p_keys text[])
RETURNS TABLE (storage_key text, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  IF coalesce(array_length(p_keys, 1), 0) > 1000 THEN RAISE EXCEPTION 'PHOTO_JOB_BATCH_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
    SELECT k.key,
           CASE WHEN EXISTS (SELECT 1 FROM public.photo_purge_queue q WHERE q.storage_key = k.key AND q.purged_at IS NULL) THEN 'queued'
                WHEN EXISTS (SELECT 1 FROM public.stored_files f JOIN public.care_event_photos p ON p.file_id = f.id
                             WHERE f.storage_key = k.key AND f.purpose = 'ACTIVITY_PHOTO' AND p.deleted_at IS NULL) THEN 'active'
                ELSE 'unknown' END
      FROM unnest(p_keys) AS k(key)
     WHERE k.key LIKE 'activity-photos/%';
END $$;
REVOKE ALL ON FUNCTION public.app_photo_classify_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_classify_keys(text[]) TO app_runtime;

-- Live photo rows (not removed) in batches, so the job can check their objects exist.
CREATE OR REPLACE FUNCTION public.app_photo_live_keys(p_after uuid, p_limit integer)
RETURNS TABLE (photo_id uuid, storage_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN QUERY
    SELECT p.id, f.storage_key FROM public.care_event_photos p JOIN public.stored_files f ON f.id = p.file_id
     WHERE p.deleted_at IS NULL AND f.purpose = 'ACTIVITY_PHOTO' AND (p_after IS NULL OR p.id > p_after)
     ORDER BY p.id LIMIT greatest(1, least(coalesce(p_limit, 200), 1000));
END $$;
REVOKE ALL ON FUNCTION public.app_photo_live_keys(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_live_keys(uuid, integer) TO app_runtime;

-- A live row whose object no longer exists (e.g. after restoring the database):
-- tombstone RECONCILED, already purged. Only called after a verified 404.
CREATE OR REPLACE FUNCTION public.app_photo_mark_missing(p_photo_id uuid)
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

-- When the last reconciliation ran (weekly cadence).
CREATE OR REPLACE FUNCTION public.app_photo_last_reconciliation() RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.app_photo_job_guard();
  RETURN (SELECT max(started_at) FROM public.photo_retention_runs WHERE reconciled);
END $$;
REVOKE ALL ON FUNCTION public.app_photo_last_reconciliation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_last_reconciliation() TO app_runtime;

-- Run log: counts and error class names only.
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
REVOKE ALL ON FUNCTION public.app_photo_record_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_photo_record_run(jsonb) TO app_runtime;

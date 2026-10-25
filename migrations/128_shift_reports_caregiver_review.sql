-- Migration 128 — Informe de Turno F2: automatic draft, caregiver review and submission.
--
-- 1. The snapshot is built in ONE place, the database (app_shift_report_build_content),
--    so the automatic draft (background worker), the agency (open/refresh) and later the
--    family (F3) all see the same thing. It only READS existing records: arrival,
--    start/end, care events, incidents and observations of that caregiver during her
--    visit. Nothing is invented. The builder is NOT callable by the app role: only the
--    guarded functions below use it.
-- 2. When a visit ends, a background tick (app_shift_reports_generate_pending, counts
--    only) creates the draft for agencies with SHIFT_REPORTS on and notifies the
--    caregiver in the portal (SHIFT_REPORT_READY).
-- 3. The caregiver reads ONLY reports of her own visits, also after the service ended,
--    while her membership in the agency is active (RLS, read-only). Within 24 hours of
--    the real end she may add one final observation (replacing it keeps the previous one
--    in the history) and send the report for review. She never edits the snapshot,
--    never approves, never deletes.
-- 4. The agency may send a submitted report back (RETURNED, with a note) while the
--    caregiver's window is still open, and approves DRAFT, SUBMITTED or RETURNED reports.
-- 5. Window expired without submission: the report stays DRAFT, unchanged; the agency
--    sees «Plazo vencido sin envío» and can review and approve it. Nothing is deleted.
-- 6. Approved reports stay immutable (guard extended to the new columns).
--
-- Additive. Rollback: ops/128_shift_reports_caregiver_review.rollback.sql (guarded).

-- 1. Columns ------------------------------------------------------------------------------
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS review_deadline_at timestamptz NULL;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS caregiver_note text NULL;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS caregiver_note_at timestamptz NULL;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS submitted_at timestamptz NULL;
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_caregiver_note_len;
ALTER TABLE shift_reports ADD CONSTRAINT shift_reports_caregiver_note_len
  CHECK (caregiver_note IS NULL OR char_length(caregiver_note) BETWEEN 1 AND 1000);
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_caregiver_note_pair;
ALTER TABLE shift_reports ADD CONSTRAINT shift_reports_caregiver_note_pair
  CHECK ((caregiver_note IS NULL) = (caregiver_note_at IS NULL));
-- Existing (F1) DRAFT reports: 24 h after the real end recorded in their snapshot.
-- Approved reports are never touched (the 126 guard forbids it, and they need no review
-- window): their deadline stays NULL, so the caregiver can read them but never edit them.
UPDATE shift_reports SET review_deadline_at = (content->'times'->'end'->>'at')::timestamptz + interval '24 hours'
WHERE status = 'DRAFT' AND review_deadline_at IS NULL AND content->'times'->'end'->>'at' IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_reports_member_idx ON shift_reports (organization_worker_membership_id, generated_at DESC);

-- 2. Guard: approved reports never change (now including the caregiver columns) ------------
CREATE OR REPLACE FUNCTION app_shift_report_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHIFT_REPORT_NOT_DELETABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.shift_id <> OLD.shift_id
     OR NEW.organization_worker_membership_id <> OLD.organization_worker_membership_id
     OR NEW.care_recipient_id <> OLD.care_recipient_id OR NEW.version <> OLD.version
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SHIFT_REPORT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('APPROVED', 'SUPERSEDED') THEN
    IF NOT (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'
            AND NEW.content = OLD.content AND NEW.content_schema = OLD.content_schema
            AND NEW.family_sections IS NOT DISTINCT FROM OLD.family_sections
            AND NEW.agency_summary IS NOT DISTINCT FROM OLD.agency_summary
            AND NEW.generated_at = OLD.generated_at
            AND NEW.approved_at = OLD.approved_at AND NEW.approved_by_user_id = OLD.approved_by_user_id
            AND NEW.caregiver_note IS NOT DISTINCT FROM OLD.caregiver_note
            AND NEW.caregiver_note_at IS NOT DISTINCT FROM OLD.caregiver_note_at
            AND NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at
            AND NEW.review_deadline_at IS NOT DISTINCT FROM OLD.review_deadline_at) THEN
      RAISE EXCEPTION 'SHIFT_REPORT_APPROVED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Nobody approves the report of their own visit (also an admin who worked it).
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' AND EXISTS (
       SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
       WHERE owm.id = NEW.organization_worker_membership_id AND w.user_id = NEW.approved_by_user_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_SELF_APPROVAL' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 3. The snapshot builder (read-only, not callable by the app role) -------------------------
CREATE OR REPLACE FUNCTION app_shift_report_iso(p timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
$$;
CREATE OR REPLACE FUNCTION app_shift_report_str(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'string' AND btrim(p #>> '{}') <> '' THEN left(p #>> '{}', 2000) END;
$$;
CREATE OR REPLACE FUNCTION app_shift_report_text(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p IS NOT NULL AND btrim(p) <> '' THEN left(p, 2000) END;
$$;

/** Finished visits of a shift: each caregiver's first check-in and the check-out that closed her last one. */
CREATE OR REPLACE FUNCTION app_shift_report_visits(p_org uuid, p_shift uuid)
RETURNS TABLE(membership_id uuid, start_at timestamptz, start_offline boolean, end_at timestamptz, end_offline boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH ev AS (
    SELECT organization_worker_membership_id AS m, event_type, occurred_at, recorded_offline
    FROM public.verification_events WHERE organization_id = p_org AND shift_id = p_shift),
  firsts AS (SELECT DISTINCT ON (m) m, occurred_at, recorded_offline FROM ev WHERE event_type = 'check_in' ORDER BY m, occurred_at),
  lastin AS (SELECT m, max(occurred_at) AS at FROM ev WHERE event_type = 'check_in' GROUP BY m),
  ends AS (SELECT DISTINCT ON (ev.m) ev.m, ev.occurred_at, ev.recorded_offline FROM ev JOIN lastin l ON l.m = ev.m
           WHERE ev.event_type = 'check_out' AND ev.occurred_at > l.at ORDER BY ev.m, ev.occurred_at DESC)
  SELECT f.m, f.occurred_at, f.recorded_offline, e.occurred_at, e.recorded_offline FROM firsts f JOIN ends e ON e.m = f.m;
$$;

CREATE OR REPLACE FUNCTION app_shift_report_build_content(p_org uuid, p_shift uuid, p_membership uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v record; h record; arr record;
  sections jsonb; incidents jsonb; observations jsonb;
  n_events int; n_photo_events int; n_photos int;
BEGIN
  SELECT * INTO v FROM public.app_shift_report_visits(p_org, p_shift) x WHERE x.membership_id = p_membership;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_VISIT_NOT_FINISHED' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id, s.scheduled_start, s.scheduled_end, s.care_recipient_id, o.name AS org_name,
         COALESCE(NULLIF(btrim(cr.preferred_name), ''), concat_ws(' ', cr.first_name, NULLIF(cr.last_name, ''))) AS recipient_name,
         w.display_name AS caregiver_name
    INTO h
    FROM public.shifts s
    JOIN public.organizations o ON o.id = s.organization_id
    JOIN public.care_recipients cr ON cr.id = s.care_recipient_id AND cr.organization_id = s.organization_id
    JOIN public.organization_worker_memberships owm ON owm.id = p_membership AND owm.organization_id = s.organization_id
    LEFT JOIN public.workers w ON w.id = owm.worker_id
   WHERE s.id = p_shift AND s.organization_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  SELECT occurred_at, proximity, recorded_offline, needs_review, reviewed_at INTO arr
    FROM public.shift_arrivals
   WHERE organization_id = p_org AND shift_id = p_shift AND organization_worker_membership_id = p_membership;

  WITH e AS (
    SELECT ce.id, t.code, ce.occurred_at, ce.note_text,
           CASE WHEN jsonb_typeof(ce.structured_data) = 'object' THEN ce.structured_data ELSE '{}'::jsonb END AS d
      FROM public.care_events ce JOIN public.care_event_types t ON t.id = ce.care_event_type_id
     WHERE ce.organization_id = p_org AND ce.shift_id = p_shift AND ce.organization_worker_membership_id = p_membership)
  SELECT jsonb_build_object(
    'meals', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'mealType', app_shift_report_str(d->'mealType'), 'amountConsumed', app_shift_report_str(d->'amountConsumed')) ORDER BY occurred_at, id) FILTER (WHERE code = 'MEAL'), '[]'::jsonb),
    'hydration', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'amount', app_shift_report_str(d->'amount')) ORDER BY occurred_at, id) FILTER (WHERE code = 'HYDRATION'), '[]'::jsonb),
    'hygiene', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'result', app_shift_report_str(d->'result')) ORDER BY occurred_at, id) FILTER (WHERE code = 'TOILETING'), '[]'::jsonb),
    'mobility', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'activity', app_shift_report_str(d->'activity')) ORDER BY occurred_at, id) FILTER (WHERE code = 'MOBILITY'), '[]'::jsonb),
    'activities', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'label', app_shift_report_str(d->'label'),
               'durationMinutes', CASE WHEN jsonb_typeof(d->'durationMinutes') = 'number' THEN d->'durationMinutes' ELSE 'null'::jsonb END) ORDER BY occurred_at, id) FILTER (WHERE code = 'ACTIVITY'), '[]'::jsonb),
    'mood', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'note', app_shift_report_text(note_text),
               'mood', app_shift_report_str(d->'mood')) ORDER BY occurred_at, id) FILTER (WHERE code = 'MOOD'), '[]'::jsonb),
    'notes', COALESCE(jsonb_agg(jsonb_build_object('careEventId', id, 'at', app_shift_report_iso(occurred_at), 'text', app_shift_report_text(note_text))
               ORDER BY occurred_at, id) FILTER (WHERE code = 'NOTE'), '[]'::jsonb)),
    count(*)::int, (count(*) FILTER (WHERE code = 'PHOTO'))::int
  INTO sections, n_events, n_photo_events FROM e;

  SELECT count(*)::int INTO n_photos FROM public.care_event_photos p
   WHERE p.organization_id = p_org AND p.care_event_id IN (
     SELECT ce.id FROM public.care_events ce WHERE ce.organization_id = p_org AND ce.shift_id = p_shift AND ce.organization_worker_membership_id = p_membership);

  -- Incidents / observations have no shift_id: those she filed for this resident during the visit.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('incidentId', i.id, 'at', app_shift_report_iso(i.created_at), 'severity', i.severity,
           'status', i.status::text, 'description', app_shift_report_text(i.description)) ORDER BY i.created_at), '[]'::jsonb)
    INTO incidents FROM public.incidents i
   WHERE i.organization_id = p_org AND i.care_recipient_id = h.care_recipient_id AND i.organization_worker_membership_id = p_membership
     AND i.created_at BETWEEN v.start_at AND v.end_at;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('observationId', o.id, 'at', app_shift_report_iso(o.created_at), 'category', o.category::text,
           'status', o.status::text, 'description', app_shift_report_text(o.description)) ORDER BY o.created_at), '[]'::jsonb)
    INTO observations FROM public.observations o
   WHERE o.organization_id = p_org AND o.care_recipient_id = h.care_recipient_id AND o.organization_worker_membership_id = p_membership
     AND o.created_at BETWEEN v.start_at AND v.end_at;

  RETURN jsonb_build_object(
    'schema', 1,
    'organization', jsonb_build_object('name', h.org_name),
    'recipient', jsonb_build_object('id', h.care_recipient_id, 'name', h.recipient_name),
    'caregiver', jsonb_build_object('membershipId', p_membership, 'name', h.caregiver_name),
    'shift', jsonb_build_object('id', h.id, 'scheduledStart', app_shift_report_iso(h.scheduled_start), 'scheduledEnd', app_shift_report_iso(h.scheduled_end)),
    'times', jsonb_build_object(
      'arrival', CASE WHEN arr.occurred_at IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('at', app_shift_report_iso(arr.occurred_at),
                 'proximity', arr.proximity, 'recordedOffline', arr.recorded_offline, 'needsReview', arr.needs_review, 'reviewed', arr.reviewed_at IS NOT NULL) END,
      'start', jsonb_build_object('at', app_shift_report_iso(v.start_at), 'recordedOffline', v.start_offline),
      'end', jsonb_build_object('at', app_shift_report_iso(v.end_at), 'recordedOffline', v.end_offline)),
    'sections', sections,
    'incidents', incidents,
    'observations', observations,
    'photos', jsonb_build_object('count', n_photos, 'photoEvents', n_photo_events),
    'totals', jsonb_build_object('careEvents', n_events, 'incidents', jsonb_array_length(incidents), 'observations', jsonb_array_length(observations)));
END;
$$;

/** Creates the missing v1 draft of one finished visit and notifies the caregiver. Internal. */
CREATE OR REPLACE FUNCTION app_shift_report_create_draft(p_org uuid, p_shift uuid, p_membership uuid, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c jsonb; rid uuid; cg_user uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.shift_reports WHERE organization_id = p_org AND shift_id = p_shift
             AND organization_worker_membership_id = p_membership AND version = 1) THEN
    RETURN NULL;
  END IF;
  c := public.app_shift_report_build_content(p_org, p_shift, p_membership);
  INSERT INTO public.shift_reports (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, content, review_deadline_at)
  VALUES (p_org, p_shift, p_membership, (c->'recipient'->>'id')::uuid, c, (c->'times'->'end'->>'at')::timestamptz + interval '24 hours')
  ON CONFLICT (organization_id, shift_id, organization_worker_membership_id, version) DO NOTHING
  RETURNING id INTO rid;
  IF rid IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, details)
  VALUES (p_org, rid, 'GENERATED', p_actor, (c->'totals') || jsonb_build_object('automatic', p_actor IS NULL));
  SELECT w.user_id INTO cg_user FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
   WHERE owm.id = p_membership AND owm.status = 'active';
  IF cg_user IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, care_recipient_id, channel, status, sent_at)
    VALUES (cg_user, p_org, 'SHIFT_REPORT_READY', 'shift_report', rid, (c->'recipient'->>'id')::uuid, 'in_app', 'sent', now());
  END IF;
  RETURN rid;
END;
$$;

/** Background tick (no tenant context): drafts for visits finished in the last 7 days. Returns a count only. */
CREATE OR REPLACE FUNCTION app_shift_reports_generate_pending()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ve.organization_id, ve.shift_id, ve.organization_worker_membership_id
      FROM public.verification_events ve
      JOIN public.shifts s ON s.id = ve.shift_id AND s.organization_id = ve.organization_id AND s.care_recipient_id IS NOT NULL
     WHERE ve.event_type = 'check_out' AND ve.occurred_at > now() - interval '7 days'
       AND public.app_org_feature_enabled(ve.organization_id, 'SHIFT_REPORTS')
       AND NOT EXISTS (SELECT 1 FROM public.shift_reports sr WHERE sr.organization_id = ve.organization_id AND sr.shift_id = ve.shift_id
                       AND sr.organization_worker_membership_id = ve.organization_worker_membership_id AND sr.version = 1)
     LIMIT 100
  LOOP
    BEGIN
      IF public.app_shift_report_create_draft(r.organization_id, r.shift_id, r.organization_worker_membership_id, NULL) IS NOT NULL THEN
        n := n + 1;
      END IF;
    EXCEPTION WHEN sqlstate 'P0002' THEN NULL; -- the visit re-opened (new check-in): later
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- 4. Agency (reviewer) entry points ---------------------------------------------------------
CREATE OR REPLACE FUNCTION app_shift_report_assert_reviewer()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
BEGIN
  IF org IS NULL OR NOT public.app_can_review_shift_reports() OR public.app_is_superadmin() THEN
    RAISE EXCEPTION 'SHIFT_REPORT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN org;
END;
$$;

/** Drafts for every finished visit of a shift that has none yet (agency opened the shift). */
CREATE OR REPLACE FUNCTION app_shift_report_ensure(p_shift uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.app_shift_report_assert_reviewer(); r record; n int := 0;
BEGIN
  FOR r IN SELECT membership_id FROM public.app_shift_report_visits(org, p_shift) LOOP
    IF public.app_shift_report_create_draft(org, p_shift, r.membership_id, NULLIF(current_setting('app.current_user_id', true), '')::uuid) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;

/** «Actualizar borrador»: rebuild a DRAFT or RETURNED report from the records. A submitted one is what the caregiver reviewed. */
CREATE OR REPLACE FUNCTION app_shift_report_refresh(p_report uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.app_shift_report_assert_reviewer(); r record; c jsonb;
BEGIN
  SELECT * INTO r FROM public.shift_reports WHERE id = p_report AND organization_id = org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('DRAFT', 'RETURNED') THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_DRAFT' USING ERRCODE = '23514'; END IF;
  c := public.app_shift_report_build_content(org, r.shift_id, r.organization_worker_membership_id);
  UPDATE public.shift_reports SET content = c, generated_at = clock_timestamp() WHERE id = p_report;
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, details)
  VALUES (org, p_report, 'REGENERATED', NULLIF(current_setting('app.current_user_id', true), '')::uuid, c->'totals');
END;
$$;

/** «Devolver»: SUBMITTED -> RETURNED with a note, only while the caregiver can still answer. */
CREATE OR REPLACE FUNCTION app_shift_report_return(p_report uuid, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := public.app_shift_report_assert_reviewer(); r record; note text := btrim(COALESCE(p_note, '')); cg_user uuid;
BEGIN
  IF char_length(note) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'RETURN_NOTE_REQUIRED' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.shift_reports WHERE id = p_report AND organization_id = org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'SUBMITTED' THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_SUBMITTED' USING ERRCODE = '23514'; END IF;
  IF r.review_deadline_at IS NULL OR now() > r.review_deadline_at THEN RAISE EXCEPTION 'SHIFT_REPORT_WINDOW_CLOSED' USING ERRCODE = '23514'; END IF;
  UPDATE public.shift_reports SET status = 'RETURNED' WHERE id = p_report;
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, note)
  VALUES (org, p_report, 'RETURNED', NULLIF(current_setting('app.current_user_id', true), '')::uuid, note);
  SELECT w.user_id INTO cg_user FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
   WHERE owm.id = r.organization_worker_membership_id AND owm.status = 'active';
  IF cg_user IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, care_recipient_id, channel, status, sent_at)
    VALUES (cg_user, org, 'SHIFT_REPORT_RETURNED', 'shift_report', p_report, r.care_recipient_id, 'in_app', 'sent', now());
  END IF;
END;
$$;

-- 5. Caregiver: her own reports only ------------------------------------------------------
/** The membership is the current user's own, active, in the current organization (and so is her agency membership). */
CREATE OR REPLACE FUNCTION app_is_my_worker_membership(p_membership uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_worker_memberships owm
    JOIN public.workers w ON w.id = owm.worker_id
    JOIN public.organization_memberships om ON om.user_id = w.user_id AND om.organization_id = owm.organization_id AND om.status = 'active'
    WHERE owm.id = p_membership AND owm.status = 'active'
      AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
$$;

DROP POLICY IF EXISTS shift_reports_own_visit_read ON shift_reports;
CREATE POLICY shift_reports_own_visit_read ON shift_reports FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND app_is_my_worker_membership(organization_worker_membership_id));
DROP POLICY IF EXISTS shift_report_events_own_visit_read ON shift_report_events;
CREATE POLICY shift_report_events_own_visit_read ON shift_report_events FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND EXISTS (SELECT 1 FROM shift_reports r WHERE r.id = shift_report_events.shift_report_id
                     AND app_is_my_worker_membership(r.organization_worker_membership_id)));

CREATE OR REPLACE FUNCTION app_shift_report_lock_own(p_report uuid)
RETURNS shift_reports LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.shift_reports;
BEGIN
  SELECT * INTO r FROM public.shift_reports WHERE id = p_report
     AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT public.app_is_my_worker_membership(r.organization_worker_membership_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.app_org_feature_enabled(r.organization_id, 'SHIFT_REPORTS') THEN
    RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  IF r.status NOT IN ('DRAFT', 'RETURNED') THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_EDITABLE' USING ERRCODE = '23514'; END IF;
  IF r.review_deadline_at IS NULL OR now() > r.review_deadline_at THEN RAISE EXCEPTION 'SHIFT_REPORT_WINDOW_CLOSED' USING ERRCODE = '23514'; END IF;
  RETURN r;
END;
$$;

/** Final observation (≤ 1000). Replacing it keeps every version in the history. Records are never edited. */
CREATE OR REPLACE FUNCTION app_shift_report_set_observation(p_report uuid, p_text text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.shift_reports := public.app_shift_report_lock_own(p_report); note text := btrim(COALESCE(p_text, ''));
BEGIN
  IF char_length(note) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'OBSERVATION_INVALID' USING ERRCODE = '22023'; END IF;
  UPDATE public.shift_reports SET caregiver_note = note, caregiver_note_at = now() WHERE id = r.id;
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, note)
  VALUES (r.organization_id, r.id, 'OBSERVATION_ADDED', NULLIF(current_setting('app.current_user_id', true), '')::uuid, note);
END;
$$;

/** «Enviar a revisión»: DRAFT/RETURNED -> SUBMITTED within 24 h of the real end. */
CREATE OR REPLACE FUNCTION app_shift_report_submit(p_report uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.shift_reports := public.app_shift_report_lock_own(p_report);
BEGIN
  UPDATE public.shift_reports SET status = 'SUBMITTED', submitted_at = now() WHERE id = r.id;
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, details)
  VALUES (r.organization_id, r.id, 'SUBMITTED', NULLIF(current_setting('app.current_user_id', true), '')::uuid,
          jsonb_build_object('withObservation', r.caregiver_note IS NOT NULL));
END;
$$;

-- 6. Privileges -----------------------------------------------------------------------------
-- Internal helpers stay owner-only: the builder reads every record of a shift.
REVOKE ALL ON FUNCTION app_shift_report_iso(timestamptz), app_shift_report_str(jsonb), app_shift_report_text(text),
  app_shift_report_visits(uuid, uuid), app_shift_report_build_content(uuid, uuid, uuid),
  app_shift_report_create_draft(uuid, uuid, uuid, uuid), app_shift_report_lock_own(uuid),
  app_shift_report_assert_reviewer(), app_shift_reports_generate_pending(), app_shift_report_ensure(uuid),
  app_shift_report_refresh(uuid), app_shift_report_return(uuid, text), app_is_my_worker_membership(uuid),
  app_shift_report_set_observation(uuid, text), app_shift_report_submit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shift_reports_generate_pending(), app_shift_report_ensure(uuid), app_shift_report_refresh(uuid),
  app_shift_report_return(uuid, text), app_is_my_worker_membership(uuid),
  app_shift_report_set_observation(uuid, text), app_shift_report_submit(uuid) TO app_runtime;

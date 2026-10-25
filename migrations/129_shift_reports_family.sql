-- 129: Informe de Turno F3 — the family reads APPROVED reports and downloads the PDF.
--
-- No table changes. Functions only:
--   * a family member reads reports of a resident only while her family relationship
--     is active AND she still holds the FAMILY role in an active membership of that
--     agency (same rule as app_user_authorized_for_recipient, family branch);
--   * only status APPROVED (the exact approved version; drafts, sent, returned and
--     superseded versions are never visible);
--   * only the sections the agency marked in family_sections at approval;
--   * internal ids, location proximity, offline flags, totals, observation records,
--     photos and the agency history are never projected;
--   * ETNARA Central (superadmin) never qualifies;
--   * SHIFT_REPORTS must be on for the agency.
-- The family never gets a SELECT policy on shift_reports: the projection below is the
-- only way in, and the PDF is rendered from the same projection (it can't show more).

-- 1. Who may read ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_is_my_family_recipient(p_recipient uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     AND EXISTS (
       SELECT 1 FROM public.family_relationships fr
        WHERE fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND fr.care_recipient_id = p_recipient
          AND fr.status = 'active')
     AND EXISTS (
       SELECT 1 FROM public.organization_memberships om
         JOIN public.user_roles ur ON ur.organization_membership_id = om.id
         JOIN public.roles r ON r.id = ur.role_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND om.status = 'active' AND r.code = 'FAMILY')
     AND EXISTS (
       SELECT 1 FROM public.organization_features f
        WHERE f.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND f.feature_code = 'SHIFT_REPORTS' AND f.enabled);
$$;

-- 2. The family projection (internal) ------------------------------------------------------
CREATE OR REPLACE FUNCTION app_shift_report_family_strip(p_items jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(jsonb_agg(e - 'careEventId' ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS t(e, ord);
$$;

CREATE OR REPLACE FUNCTION app_shift_report_family_project(p_report uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r public.shift_reports%ROWTYPE;
  c jsonb; fs jsonb; sec jsonb := '{}'::jsonb; shown text[] := ARRAY[]::text[];
  k text;
BEGIN
  SELECT * INTO r FROM public.shift_reports
   WHERE id = p_report AND status = 'APPROVED'
     AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  c := r.content; fs := r.family_sections;

  IF COALESCE((fs->>'schedule')::boolean, false) THEN
    sec := sec || jsonb_build_object('schedule', jsonb_build_object(
      'scheduledStart', c->'shift'->'scheduledStart', 'scheduledEnd', c->'shift'->'scheduledEnd',
      'arrivalAt', c->'times'->'arrival'->'at', 'startAt', c->'times'->'start'->'at', 'endAt', c->'times'->'end'->'at'));
    shown := array_append(shown, 'schedule');
  END IF;
  FOREACH k IN ARRAY ARRAY['meals', 'hydration', 'activities', 'mobility', 'hygiene', 'mood'] LOOP
    IF COALESCE((fs->>k)::boolean, false) THEN
      sec := sec || jsonb_build_object(k, app_shift_report_family_strip(c->'sections'->k));
      shown := array_append(shown, k);
    END IF;
  END LOOP;
  IF COALESCE((fs->>'observations')::boolean, false) THEN
    -- Free-text notes and the caregiver's final observation. Observation RECORDS
    -- (categories, review status) stay in the agency's own review flow.
    sec := sec || jsonb_build_object('observations', jsonb_build_object(
      'notes', app_shift_report_family_strip(c->'sections'->'notes'),
      'caregiverNote', CASE WHEN r.caregiver_note IS NULL THEN 'null'::jsonb
                            ELSE jsonb_build_object('at', app_shift_report_iso(r.caregiver_note_at), 'text', r.caregiver_note) END));
    shown := array_append(shown, 'observations');
  END IF;
  IF COALESCE((fs->>'incidents')::boolean, false) THEN
    sec := sec || jsonb_build_object('incidents', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('at', i->'at', 'severity', i->'severity', 'description', i->'description') ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(c->'incidents', '[]'::jsonb)) WITH ORDINALITY AS t(i, ord)));
    shown := array_append(shown, 'incidents');
  END IF;
  -- photos: shared through their own approval (care_event_photos), never inside the report.

  RETURN jsonb_build_object(
    'id', r.id, 'version', r.version, 'status', r.status,
    'approvedAt', app_shift_report_iso(r.approved_at),
    'serviceDate', to_char((c->'shift'->>'scheduledStart')::timestamptz AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD'),
    'organization', jsonb_build_object('name', c->'organization'->'name'),
    'recipient', jsonb_build_object('name', c->'recipient'->'name'),
    'caregiver', jsonb_build_object('name', c->'caregiver'->'name'),
    'agencySummary', r.agency_summary,
    'shown', to_jsonb(shown),
    'sections', sec);
END;
$$;

-- 3. What the family calls -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_shift_report_family_list(p_recipient uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT app_is_my_family_recipient(p_recipient) THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND'; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.id, 'approvedAt', app_shift_report_iso(r.approved_at),
             'serviceDate', to_char((r.content->'shift'->>'scheduledStart')::timestamptz AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD'),
             'scheduledStart', CASE WHEN COALESCE((r.family_sections->>'schedule')::boolean, false) THEN r.content->'shift'->'scheduledStart' ELSE 'null'::jsonb END,
             'scheduledEnd', CASE WHEN COALESCE((r.family_sections->>'schedule')::boolean, false) THEN r.content->'shift'->'scheduledEnd' ELSE 'null'::jsonb END,
             'caregiverName', r.content->'caregiver'->'name')
           ORDER BY (r.content->'shift'->>'scheduledStart') DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.shift_reports
             WHERE organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
               AND care_recipient_id = p_recipient AND status = 'APPROVED'
             ORDER BY (content->'shift'->>'scheduledStart') DESC LIMIT 100) r);
END;
$$;

CREATE OR REPLACE FUNCTION app_shift_report_family_get(p_recipient uuid, p_report uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_out jsonb;
BEGIN
  IF NOT app_is_my_family_recipient(p_recipient) THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shift_reports WHERE id = p_report AND care_recipient_id = p_recipient
                   AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND';
  END IF;
  v_out := app_shift_report_family_project(p_report);
  IF v_out IS NULL THEN RAISE EXCEPTION 'SHIFT_REPORT_NOT_FOUND'; END IF;
  RETURN v_out;
END;
$$;

-- The download is recorded in the report history (who and when; no content).
CREATE OR REPLACE FUNCTION app_shift_report_family_pdf(p_recipient uuid, p_report uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_out jsonb;
BEGIN
  v_out := app_shift_report_family_get(p_recipient, p_report);
  INSERT INTO public.shift_report_events (organization_id, shift_report_id, event_type, actor_user_id, details)
  VALUES (NULLIF(current_setting('app.current_org_id', true), '')::uuid, p_report, 'PDF_DOWNLOADED',
          NULLIF(current_setting('app.current_user_id', true), '')::uuid, jsonb_build_object('by', 'family'));
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION app_is_my_family_recipient(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_family_strip(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_family_project(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_family_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_family_get(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_shift_report_family_pdf(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_shift_report_family_list(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_shift_report_family_get(uuid, uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_shift_report_family_pdf(uuid, uuid) TO app_runtime;

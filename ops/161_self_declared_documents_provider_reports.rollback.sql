-- Reversión de 161. Restaura EXACTAMENTE las funciones de la 149, 128 y 129, quita el guarda de requisitos, la
-- función del operador independiente y las dos columnas. Se NIEGA si ya existen documentos autodeclarados o informes
-- del proveedor: al quitar la columna parecerían registros de agencia (y una agencia podría contarlos sin revisión).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credentials WHERE declared_by_holder) OR EXISTS (SELECT 1 FROM shift_reports WHERE published_by_provider) THEN
    RAISE EXCEPTION 'ROLLBACK_161_REFUSED: existen documentos autodeclarados o informes del proveedor; revisar con Rafa antes de revertir';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.app_credential_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_owner uuid;
  v_evidence_only boolean := false;
BEGIN
  -- Only the application is restricted (also inside SECURITY DEFINER functions it calls).
  IF current_user <> 'app_runtime' AND session_user <> 'app_runtime' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_owner := public.app_credential_owner_user(COALESCE(NEW.worker_id, OLD.worker_id));

  IF TG_OP = 'UPDATE' THEN
    -- Attaching evidence is the only change the owner (or anyone) may make without managing data.
    v_evidence_only := NEW.worker_id = OLD.worker_id
      AND NEW.credential_type_id = OLD.credential_type_id
      AND NEW.issuing_entity_name IS NOT DISTINCT FROM OLD.issuing_entity_name
      AND NEW.issuing_entity_type = OLD.issuing_entity_type
      AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
      AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
      AND NEW.status = OLD.status
      AND NEW.created_at = OLD.created_at;
    IF NEW.worker_id <> OLD.worker_id THEN
      RAISE EXCEPTION 'CREDENTIAL_MANAGER_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_evidence_only THEN
    RETURN NEW;
  END IF;
  IF v_owner IS NOT NULL AND v_actor IS NOT NULL AND v_owner = v_actor THEN
    RAISE EXCEPTION 'CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT app_is_org_manager() THEN
    RAISE EXCEPTION 'CREDENTIAL_MANAGER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
      sec := sec || jsonb_build_object(k, app_shift_report_family_pick(c->'sections'->k, CASE k
        WHEN 'meals' THEN ARRAY['at', 'mealType', 'amountConsumed', 'note']
        WHEN 'hydration' THEN ARRAY['at', 'amount', 'note']
        WHEN 'activities' THEN ARRAY['at', 'label', 'durationMinutes', 'note']
        WHEN 'mobility' THEN ARRAY['at', 'activity', 'note']
        WHEN 'hygiene' THEN ARRAY['at', 'result', 'note']
        ELSE ARRAY['at', 'mood', 'note'] END));
      shown := array_append(shown, k);
    END IF;
  END LOOP;
  IF COALESCE((fs->>'observations')::boolean, false) THEN
    -- Free-text notes and the caregiver's final observation. Observation RECORDS
    -- (categories, review status) stay in the agency's own review flow.
    sec := sec || jsonb_build_object('observations', jsonb_build_object(
      'notes', app_shift_report_family_pick(c->'sections'->'notes', ARRAY['at', 'text']),
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

DROP TRIGGER IF EXISTS assignments_self_declaration_guard ON assignments;
DROP FUNCTION IF EXISTS public.app_assignment_self_declaration_guard();
DROP TRIGGER IF EXISTS document_versions_declared_guard ON document_versions;
DROP FUNCTION IF EXISTS public.app_declared_document_version_guard();
DROP TRIGGER IF EXISTS requirements_independent_guard ON requirements;
DROP FUNCTION IF EXISTS public.app_independent_requirement_guard();
DROP FUNCTION IF EXISTS public.app_reset_declared_credential_reviews(uuid);
DROP FUNCTION IF EXISTS public.app_is_independent_operator(uuid, uuid);
ALTER TABLE shift_reports DROP COLUMN IF EXISTS published_by_provider;
ALTER TABLE assignments DROP COLUMN IF EXISTS self_declaration_confirmed_at;
ALTER TABLE credentials DROP COLUMN IF EXISTS declared_by_holder;
DELETE FROM schema_migrations WHERE filename = '161_self_declared_documents_provider_reports.sql';
COMMIT;

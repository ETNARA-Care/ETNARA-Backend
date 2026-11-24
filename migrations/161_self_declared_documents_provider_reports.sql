-- 161 · Cuidador independiente, PR C: documentos autodeclarados, elegibilidad propia e «Informe del proveedor». 23-nov-2026.
--
-- Decisiones de Rafa (23-nov-2026):
--   * ETNARA Care no verifica, aprueba ni certifica documentos de independientes: son AUTODECLARADOS por su titular.
--   * Estados por fechas (Registrado · Vence pronto · Vencido · Falta). Nunca «Verificado» ni «Aprobado».
--   * Faltante o vencido: advertencia + confirmación expresa auditada (no es autorización legal para trabajar).
--   * El independiente publica su informe de visita como «Informe del proveedor», sin revisión de terceros.
--   * Una agencia nunca hereda nada de la modalidad independiente: un documento autodeclarado solo le cuenta tras
--     la revisión aprobada de ESA agencia (backend, eligibility.service).
--   * Agencias y hogares: guardas de credenciales, autorrevisión y autoaprobación de informes intactos.
--
-- Cambios:
--   1. credentials.declared_by_holder (origen inmutable) y shift_reports.published_by_provider.
--   2. app_is_independent_operator(): la única persona operativa de su organización INDEPENDENT_PROVIDER.
--   3. app_credential_write_guard = 149 + rama 161 (solo documentos autodeclarados, solo su titular operativa).
--   4. requirements: en un independiente nunca se exige «revisión de la organización» (nadie más podría revisar).
--   5. app_shift_report_guard = 128 + excepción 161 para «Informe del proveedor» en independientes.
--   6. app_shift_report_family_project / _list = 129 + campo publishedByProvider (la familia ve la etiqueta).
-- Reversión: ops/161_self_declared_documents_provider_reports.rollback.sql (se niega si ya hay datos autodeclarados
-- o informes del proveedor, para no convertirlos en registros de agencia).

-- 1. Columnas -----------------------------------------------------------------------------------------------------
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS declared_by_holder boolean NOT NULL DEFAULT false;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS published_by_provider boolean NOT NULL DEFAULT false;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS self_declaration_confirmed_at timestamptz NULL;
COMMENT ON COLUMN credentials.declared_by_holder IS '161: registrado por su titular en su práctica independiente. Autodeclarado: ETNARA no lo verifica ni lo aprueba.';
COMMENT ON COLUMN assignments.self_declaration_confirmed_at IS '161: el cuidador independiente confirmó expresamente (auditado) que cumple los requisitos de este servicio pese a faltantes o vencidos. No es autorización legal.';
COMMENT ON COLUMN shift_reports.published_by_provider IS '161: publicado a la familia por el propio cuidador independiente («Informe del proveedor»), sin revisión de terceros.';

-- 2. La única persona operativa de una organización independiente ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_is_independent_operator(p_user_id uuid, p_organization_id uuid)
RETURNS boolean AS $$
  SELECT p_user_id IS NOT NULL AND p_organization_id IS NOT NULL
    -- Solo responde sobre la persona de la sesión: no sirve para sondear a otras cuentas.
    AND p_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND public.app_org_is_independent(p_organization_id)
    AND EXISTS (SELECT 1 FROM public.organization_memberships om
                JOIN public.user_roles ur ON ur.organization_membership_id = om.id
                JOIN public.roles r ON r.id = ur.role_id AND r.code = 'ORGANIZATION_ADMIN'
                WHERE om.user_id = p_user_id AND om.organization_id = p_organization_id AND om.status = 'active')
    AND EXISTS (SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
                WHERE w.user_id = p_user_id AND owm.organization_id = p_organization_id AND owm.status = 'active');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.app_is_independent_operator(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_independent_operator(uuid, uuid) TO app_runtime;

-- 2b. Un documento autodeclarado cambiado por su titular vuelve a «pendiente» en TODAS las organizaciones que lo
--     hubieran revisado: ninguna agencia conserva una aprobación sobre datos o evidencia que ya cambiaron.
CREATE OR REPLACE FUNCTION public.app_reset_declared_credential_reviews(p_credential_id uuid)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.credentials c WHERE c.id = p_credential_id AND c.declared_by_holder
                 AND public.app_credential_owner_user(c.worker_id) = NULLIF(current_setting('app.current_user_id', true), '')::uuid) THEN
    RETURN;
  END IF;
  UPDATE public.organization_credential_reviews SET review_status = 'pending', notes = NULL, reviewed_at = NULL
  WHERE credential_id = p_credential_id AND review_status <> 'pending';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.app_reset_declared_credential_reviews(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_reset_declared_credential_reviews(uuid) TO app_runtime;

-- 3. Guarda de credenciales: cuerpo de la 149 + rama «161» ----------------------------------------------------------
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
    -- 161: el origen (autodeclarado por su titular o registrado por una agencia) no cambia nunca.
    IF NEW.declared_by_holder IS DISTINCT FROM OLD.declared_by_holder THEN
      RAISE EXCEPTION 'CREDENTIAL_ORIGIN_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 161: un documento autodeclarado solo lo cambia su titular, también su evidencia (una agencia lo revisa, no
  -- le adjunta archivos), y cualquier cambio de datos o de evidencia devuelve a «pendiente» todas sus revisiones.
  IF TG_OP = 'UPDATE' AND OLD.declared_by_holder THEN
    IF v_owner IS NULL OR v_actor IS NULL OR v_owner <> v_actor THEN
      RAISE EXCEPTION 'CREDENTIAL_SELF_DECLARATION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NOT v_evidence_only OR NEW.document_id IS DISTINCT FROM OLD.document_id THEN
      PERFORM public.app_reset_declared_credential_reviews(OLD.id);
    END IF;
  END IF;
  IF v_evidence_only THEN
    RETURN NEW;
  END IF;
  -- 161: documento AUTODECLARADO de un cuidador independiente. Solo su titular, solo actuando en su propia
  -- organización INDEPENDENT_PROVIDER como su única persona operativa. Nadie más lo crea ni lo cambia (una agencia
  -- lo revisa con su propio flujo, nunca lo edita) y no se borra (se marca 'revoked'). Todo lo demás sigue igual.
  IF (TG_OP <> 'DELETE' AND NEW.declared_by_holder) OR (TG_OP = 'DELETE' AND OLD.declared_by_holder) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'CREDENTIAL_SELF_DECLARED_NOT_DELETABLE' USING ERRCODE = '42501';
    END IF;
    IF v_owner IS NULL OR v_actor IS NULL OR v_owner <> v_actor
       OR NOT public.app_is_independent_operator(v_actor, NULLIF(current_setting('app.current_org_id', true), '')::uuid) THEN
      RAISE EXCEPTION 'CREDENTIAL_SELF_DECLARATION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
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

-- 3b. Evidencia (archivo) de un documento autodeclarado: solo su titular la añade, y cada versión nueva devuelve a
--     «pendiente» las revisiones de todas las organizaciones (el archivo vive en documents/document_versions).
CREATE OR REPLACE FUNCTION public.app_declared_document_version_guard()
RETURNS trigger AS $$
DECLARE
  v_credential uuid;
  v_owner uuid;
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF current_user <> 'app_runtime' AND session_user <> 'app_runtime' THEN
    RETURN NEW;
  END IF;
  SELECT c.id, public.app_credential_owner_user(c.worker_id) INTO v_credential, v_owner
    FROM public.credentials c WHERE c.document_id = NEW.document_id AND c.declared_by_holder LIMIT 1;
  IF v_credential IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_owner IS NULL OR v_actor IS NULL OR v_owner <> v_actor THEN
    RAISE EXCEPTION 'CREDENTIAL_SELF_DECLARATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM public.app_reset_declared_credential_reviews(v_credential);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.app_declared_document_version_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS document_versions_declared_guard ON document_versions;
CREATE TRIGGER document_versions_declared_guard BEFORE INSERT ON document_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_declared_document_version_guard();

-- 4. Requisitos de un independiente: sin «revisión de la organización» --------------------------------------------
CREATE OR REPLACE FUNCTION public.app_independent_requirement_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.requires_organization_review AND EXISTS (
       SELECT 1 FROM public.requirement_sets rs WHERE rs.id = NEW.requirement_set_id AND rs.organization_id IS NOT NULL
         AND public.app_org_is_independent(rs.organization_id)) THEN
    RAISE EXCEPTION 'INDEPENDENT_REQUIREMENT_NO_REVIEW' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.app_independent_requirement_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS requirements_independent_guard ON requirements;
CREATE TRIGGER requirements_independent_guard BEFORE INSERT OR UPDATE ON requirements
  FOR EACH ROW EXECUTE FUNCTION public.app_independent_requirement_guard();

-- 4b. La confirmación expresa en una asignación solo existe en un cuidador independiente, y es de la propia persona.
CREATE OR REPLACE FUNCTION public.app_assignment_self_declaration_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.self_declaration_confirmed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.self_declaration_confirmed_at IS DISTINCT FROM NEW.self_declaration_confirmed_at) THEN
    IF NOT public.app_org_is_independent(NEW.organization_id) OR NOT EXISTS (
         SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
         WHERE owm.id = NEW.organization_worker_membership_id
           AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) THEN
      RAISE EXCEPTION 'SELF_DECLARATION_INDEPENDENT_ONLY' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.app_assignment_self_declaration_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS assignments_self_declaration_guard ON assignments;
CREATE TRIGGER assignments_self_declaration_guard BEFORE INSERT OR UPDATE OF self_declaration_confirmed_at ON assignments
  FOR EACH ROW EXECUTE FUNCTION public.app_assignment_self_declaration_guard();

-- 5. Guarda de informes: cuerpo de la 128 + excepción «161» ----------------------------------------------------------
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
            AND NEW.review_deadline_at IS NOT DISTINCT FROM OLD.review_deadline_at
            AND NEW.published_by_provider = OLD.published_by_provider) THEN
      RAISE EXCEPTION 'SHIFT_REPORT_APPROVED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- 161: «Informe del proveedor» solo existe en un cuidador independiente.
  IF NEW.published_by_provider AND NOT OLD.published_by_provider
     AND NOT public.app_org_is_independent(NEW.organization_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_PROVIDER_PUBLISH_INDEPENDENT_ONLY' USING ERRCODE = '42501';
  END IF;
  -- 161: un «Informe del proveedor» siempre identifica a quien prestó el servicio (nunca «Cuidador: —»).
  IF NEW.published_by_provider AND NOT OLD.published_by_provider
     AND COALESCE(btrim(NEW.content->'caregiver'->>'name'), '') = '' THEN
    RAISE EXCEPTION 'PROVIDER_NAME_REQUIRED' USING ERRCODE = '23514';
  END IF;
  -- Nobody approves the report of their own visit (also an admin who worked it).
  -- 161: excepción única: el cuidador independiente PUBLICA su propio informe como «Informe del proveedor»
  -- (published_by_provider), sin que nadie lo presente como revisado ni aprobado por terceros.
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED'
     AND NOT (NEW.published_by_provider AND public.app_org_is_independent(NEW.organization_id)) AND EXISTS (
       SELECT 1 FROM public.organization_worker_memberships owm JOIN public.workers w ON w.id = owm.worker_id
       WHERE owm.id = NEW.organization_worker_membership_id AND w.user_id = NEW.approved_by_user_id) THEN
    RAISE EXCEPTION 'SHIFT_REPORT_SELF_APPROVAL' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 6. Lo que ve la familia: cuerpos de la 129 + publishedByProvider ----------------------------------------------------
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
    'publishedByProvider', r.published_by_provider,
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
             'caregiverName', r.content->'caregiver'->'name',
             'publishedByProvider', r.published_by_provider)
           ORDER BY (r.content->'shift'->>'scheduledStart') DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.shift_reports
             WHERE organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
               AND care_recipient_id = p_recipient AND status = 'APPROVED'
             ORDER BY (content->'shift'->>'scheduledStart') DESC LIMIT 100) r);
END;
$$;

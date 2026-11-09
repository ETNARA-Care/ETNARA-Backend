-- 153: contrato SaaS v1.0 — aprobación jurídica, representantes designados, Orden de Suscripción por
-- agencia, evidencia de consentimiento y reglas de acceso (APAGADAS). 9-nov-2026, desarrollo local.
-- Se apoya en 152 sin modificar sus tablas de evidencia ni su lógica (solo añade columnas, tablas y
-- triggers, y redefine dos políticas de lectura para los documentos de una sola agencia).
--
--   * Aprobación jurídica: una versión NO marcada como prueba solo puede publicarse si ETNARA Central
--     registró su aprobación jurídica (referencia escrita) SOBRE ESA HUELLA exacta; si el texto cambia
--     en borrador, la aprobación se anula. El Contrato General v1.0 (borrador) queda en
--     «pending_legal_approval» y no se puede publicar ni aceptar.
--   * Copia del documento original: nombre y SHA-256 del archivo fuente (.docx) junto a la huella del texto.
--   * Representantes designados: ETNARA Central registra quién representa a cada agencia en su
--     contrato con ETNARA (relación contractual propia, no aprobación de documentos de la agencia).
--     Documento oficial: solo firma una ORGANIZATION_ADMIN activa que además esté designada.
--     Documento de prueba: si la agencia tiene designaciones, solo las designadas; si no, cualquier
--     administradora activa. El acceso administrativo, por sí solo, no basta para firmar lo oficial.
--   * Orden de Suscripción: documento de UNA agencia (kind SUBSCRIPTION_ORDER, organization_id), con
--     condiciones comerciales estructuradas e inalterables tras publicarse. Solo la ve esa agencia.
--     No crea cobros ni suscripciones.
--   * Evidencia: texto exacto de la casilla de aceptación, declaración de autoridad (texto nuevo),
--     método de consentimiento, si se descargó el documento antes de aceptar y la designación usada.
--   * Reglas de acceso: modo por agencia (off | notice | restrict_new_operations | contract_only) y
--     fecha de inicio, decididos por Central. Sin efecto alguno salvo CONTRACTS_ENFORCEMENT=on en el
--     servidor (apagado por defecto). Nunca afectan a cuidadores ni familiares ni a turnos en curso.
-- Idempotente. Reversión: ops/153_contract_saas_v1.rollback.sql (se niega con evidencia oficial).

-- ---------------------------------------------------------------- catálogo: alcance por agencia
ALTER TABLE contract_documents ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE contract_documents ADD COLUMN IF NOT EXISTS required_for_operation boolean NOT NULL DEFAULT false;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_kind_check;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_kind_check CHECK (kind IN ('SERVICE_AGREEMENT', 'TERMS_OF_USE', 'PRIVACY_NOTICE',
  'DATA_PROCESSING', 'BUSINESS_ASSOCIATE', 'OTHER', 'SUBSCRIPTION_ORDER'));
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_order_scope;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_order_scope CHECK ((kind = 'SUBSCRIPTION_ORDER') = (organization_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS contract_documents_organization ON contract_documents (organization_id) WHERE organization_id IS NOT NULL;

-- ---------------------------------------------------------------- versiones: aprobación jurídica, fuente y condiciones
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_status text NOT NULL DEFAULT 'pending_legal_approval';
ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_legal_status_check;
ALTER TABLE contract_document_versions ADD CONSTRAINT contract_document_versions_legal_status_check CHECK (legal_status IN ('pending_legal_approval', 'legally_approved'));
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_approved_at timestamptz;
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_approved_by_user_id uuid REFERENCES users(id);
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_approval_reference text;
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_approved_sha256 text;
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS source_file_name text;
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS source_file_sha256 text;
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS commercial_terms jsonb;
ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_source_check;
ALTER TABLE contract_document_versions ADD CONSTRAINT contract_document_versions_source_check CHECK (
  (source_file_sha256 IS NULL OR source_file_sha256 ~ '^[0-9a-f]{64}$')
  AND (source_file_name IS NULL OR length(source_file_name) BETWEEN 1 AND 200));

-- Sin RLS: devuelve la agencia de un documento (evita la recursión entre las políticas de ambas tablas).
CREATE OR REPLACE FUNCTION public.app_contract_document_org(p_document uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT organization_id FROM public.contract_documents WHERE id = p_document $$;
REVOKE ALL ON FUNCTION public.app_contract_document_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_document_org(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_contract_version_legal_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Corre después de contract_document_versions_guard (152): content_sha256 ya está calculada.
  IF TG_OP = 'INSERT' THEN
    NEW.legal_status := 'pending_legal_approval';
    NEW.legal_approved_at := NULL; NEW.legal_approved_by_user_id := NULL;
    NEW.legal_approval_reference := NULL; NEW.legal_approved_sha256 := NULL;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.legal_status IS DISTINCT FROM OLD.legal_status OR NEW.legal_approved_at IS DISTINCT FROM OLD.legal_approved_at
       OR NEW.legal_approved_by_user_id IS DISTINCT FROM OLD.legal_approved_by_user_id
       OR NEW.legal_approval_reference IS DISTINCT FROM OLD.legal_approval_reference
       OR NEW.legal_approved_sha256 IS DISTINCT FROM OLD.legal_approved_sha256
       OR NEW.source_file_name IS DISTINCT FROM OLD.source_file_name OR NEW.source_file_sha256 IS DISTINCT FROM OLD.source_file_sha256
       OR NEW.commercial_terms IS DISTINCT FROM OLD.commercial_terms THEN
      RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- Borrador: una aprobación vale solo para el texto y las condiciones que se aprobaron.
  IF OLD.legal_status = 'legally_approved' AND NEW.legal_status = 'legally_approved'
     AND (NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.commercial_terms IS DISTINCT FROM OLD.commercial_terms
          OR NEW.version_label IS DISTINCT FROM OLD.version_label OR NEW.source_file_sha256 IS DISTINCT FROM OLD.source_file_sha256) THEN
    NEW.legal_status := 'pending_legal_approval';
  END IF;
  IF NEW.legal_status = 'legally_approved' AND OLD.legal_status = 'pending_legal_approval' THEN
    IF NEW.legal_approved_by_user_id IS NULL OR length(btrim(coalesce(NEW.legal_approval_reference, ''))) < 10 THEN
      RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REFERENCE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    NEW.legal_approved_at := now();
    NEW.legal_approved_sha256 := NEW.content_sha256;
  ELSIF NEW.legal_status = 'pending_legal_approval' THEN
    NEW.legal_approved_at := NULL; NEW.legal_approved_by_user_id := NULL;
    NEW.legal_approval_reference := NULL; NEW.legal_approved_sha256 := NULL;
  END IF;
  -- Publicar un documento oficial exige la aprobación jurídica de ESTE texto.
  IF NEW.status = 'published' AND NOT NEW.is_test
     AND (NEW.legal_status <> 'legally_approved' OR NEW.legal_approved_sha256 IS DISTINCT FROM NEW.content_sha256) THEN
    RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_version_legal_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_document_versions_legal_guard ON contract_document_versions;
CREATE TRIGGER contract_document_versions_legal_guard
  BEFORE INSERT OR UPDATE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_version_legal_guard();

-- ---------------------------------------------------------------- representantes designados
CREATE TABLE IF NOT EXISTS organization_contract_signatories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  user_id               uuid NOT NULL REFERENCES users(id),
  full_name             text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 5 AND 150 AND btrim(full_name) ~ '\S+\s+\S+'),
  title                 text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 100),
  basis                 text NOT NULL CHECK (length(btrim(basis)) BETWEEN 10 AND 500),
  designated_by_user_id uuid NOT NULL REFERENCES users(id),
  designated_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_by_user_id    uuid REFERENCES users(id),
  revoke_reason         text
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_contract_signatories_active
  ON organization_contract_signatories (organization_id, user_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.app_contract_signatory_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CONTRACT_SIGNATORY_IMMUTABLE' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.designated_at := now(); NEW.revoked_at := NULL; NEW.revoked_by_user_id := NULL; NEW.revoke_reason := NULL;
    RETURN NEW;
  END IF;
  -- Solo se puede revocar, una vez, con motivo.
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id
     OR NEW.full_name <> OLD.full_name OR NEW.title <> OLD.title OR NEW.basis <> OLD.basis
     OR NEW.designated_by_user_id <> OLD.designated_by_user_id OR NEW.designated_at <> OLD.designated_at
     OR NEW.revoked_by_user_id IS NULL OR length(btrim(coalesce(NEW.revoke_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATORY_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_signatory_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS organization_contract_signatories_guard ON organization_contract_signatories;
CREATE TRIGGER organization_contract_signatories_guard
  BEFORE INSERT OR UPDATE OR DELETE ON organization_contract_signatories
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_signatory_guard();

/**
 * Regla de firma: devuelve la designación activa de esa persona (o NULL) y si hace falta una.
 * Oficial → hace falta. Prueba → hace falta solo si la agencia tiene o tuvo alguna designación.
 */
CREATE OR REPLACE FUNCTION public.app_contract_signatory_rule(p_org uuid, p_user uuid, p_is_test boolean)
RETURNS TABLE (designation_id uuid, required boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT (SELECT s.id FROM public.organization_contract_signatories s
           WHERE s.organization_id = p_org AND s.user_id = p_user AND s.revoked_at IS NULL LIMIT 1),
         -- Una vez que la agencia tiene (o tuvo) designaciones, revocarlas no reabre la firma a cualquiera.
         (NOT p_is_test) OR EXISTS (SELECT 1 FROM public.organization_contract_signatories s
                                     WHERE s.organization_id = p_org)
$$;
REVOKE ALL ON FUNCTION public.app_contract_signatory_rule(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_signatory_rule(uuid, uuid, boolean) TO app_runtime;

-- ¿La agencia ya opera? (residentes o turnos). Central lo consulta sin depender de las políticas de cada tabla.
CREATE OR REPLACE FUNCTION public.app_contract_org_has_operational_data(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.care_recipients WHERE organization_id = p_org)
      OR EXISTS (SELECT 1 FROM public.shifts WHERE organization_id = p_org)
$$;
REVOKE ALL ON FUNCTION public.app_contract_org_has_operational_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_org_has_operational_data(uuid) TO app_runtime;

-- ---------------------------------------------------------------- descargas (prueba de «tuve oportunidad de descargarlo»)
CREATE TABLE IF NOT EXISTS contract_document_downloads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  document_version_id uuid NOT NULL REFERENCES contract_document_versions(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  format              text NOT NULL CHECK (format IN ('pdf', 'txt')),
  downloaded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_document_downloads_lookup ON contract_document_downloads (organization_id, user_id, document_version_id);
CREATE OR REPLACE FUNCTION public.app_contract_download_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'CONTRACT_HISTORY_IMMUTABLE' USING ERRCODE = '42501'; END IF;
  NEW.downloaded_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_download_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_document_downloads_guard ON contract_document_downloads;
CREATE TRIGGER contract_document_downloads_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_document_downloads
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_download_guard();

-- ---------------------------------------------------------------- evidencia de consentimiento
ALTER TABLE organization_contract_acceptances ADD COLUMN IF NOT EXISTS acceptance_checkbox_text text;
ALTER TABLE organization_contract_acceptances ADD COLUMN IF NOT EXISTS consent_method text;
ALTER TABLE organization_contract_acceptances ADD COLUMN IF NOT EXISTS document_downloaded_at timestamptz;
ALTER TABLE organization_contract_acceptances ADD COLUMN IF NOT EXISTS signatory_designation_id uuid REFERENCES organization_contract_signatories(id);

-- Textos fijos que muestran las casillas (la base los guarda en cada evidencia nueva).
CREATE OR REPLACE FUNCTION public.app_contract_acceptance_checkbox_text()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 'He leído el contrato completo, tuve oportunidad de descargarlo y acepto sus términos.'::text $$;
REVOKE ALL ON FUNCTION public.app_contract_acceptance_checkbox_text() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_acceptance_checkbox_text() TO app_runtime;
CREATE OR REPLACE FUNCTION public.app_contract_authority_declaration()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 'Declaro que tengo autoridad legal suficiente para representar y obligar contractualmente a esta agencia.'::text $$;

-- Alcance, aprobación jurídica y representante designada (para los códigos y para la evidencia).
CREATE OR REPLACE FUNCTION public.app_contract_saas_signing_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_doc_org uuid;
  v_is_test boolean;
  v_legal text;
  v_legal_sha text;
  v_sha text;
  v_org uuid;
  v_user uuid;
  v_version uuid;
  v_designation uuid;
  v_required boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF; -- UPDATE/DELETE ya los cierra 152
  IF TG_TABLE_NAME = 'contract_signature_challenges' THEN
    v_org := NEW.organization_id; v_user := NEW.user_id; v_version := NEW.document_version_id;
  ELSE
    v_org := NEW.organization_id; v_user := NEW.accepted_by_user_id; v_version := NEW.document_version_id;
  END IF;
  SELECT public.app_contract_document_org(v.document_id), v.is_test, v.legal_status, v.legal_approved_sha256, v.content_sha256
    INTO v_doc_org, v_is_test, v_legal, v_legal_sha, v_sha
    FROM contract_document_versions v WHERE v.id = v_version;
  -- Un documento de otra agencia (Orden de Suscripción ajena) nunca se firma.
  IF v_doc_org IS NOT NULL AND v_doc_org <> v_org THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_NOT_ACCEPTABLE' USING ERRCODE = '22023';
  END IF;
  IF v_is_test IS FALSE AND (v_legal IS DISTINCT FROM 'legally_approved' OR v_legal_sha IS DISTINCT FROM v_sha) THEN
    RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT r.designation_id, r.required INTO v_designation, v_required FROM public.app_contract_signatory_rule(v_org, v_user, coalesce(v_is_test, true)) r;
  IF v_required AND v_designation IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_SIGNATORY_NOT_DESIGNATED' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'organization_contract_acceptances' THEN
    NEW.signatory_designation_id := v_designation;
    NEW.acceptance_checkbox_text := public.app_contract_acceptance_checkbox_text();
    NEW.consent_method := 'CHECKBOXES_AND_EMAIL_CODE';
    NEW.document_downloaded_at := (SELECT min(d.downloaded_at) FROM contract_document_downloads d
                                    WHERE d.organization_id = v_org AND d.user_id = v_user AND d.document_version_id = v_version);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_saas_signing_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_signature_challenges_saas_guard ON contract_signature_challenges;
CREATE TRIGGER contract_signature_challenges_saas_guard
  BEFORE INSERT ON contract_signature_challenges
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_saas_signing_guard();
DROP TRIGGER IF EXISTS organization_contract_acceptances_saas_guard ON organization_contract_acceptances;
CREATE TRIGGER organization_contract_acceptances_saas_guard
  BEFORE INSERT ON organization_contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_saas_signing_guard();

-- ---------------------------------------------------------------- reglas de acceso (APAGADAS)
CREATE TABLE IF NOT EXISTS organization_contract_enforcement (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  mode            text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'notice', 'restrict_new_operations', 'contract_only')),
  enforce_from    timestamptz,
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  set_by_user_id  uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_contract_enforcement_date CHECK (mode IN ('off', 'notice') OR enforce_from IS NOT NULL)
);

/**
 * Estado contractual de una agencia para las reglas de acceso: modo, fecha y si cumple (aceptó la
 * versión vigente de cada documento obligatorio que le aplica, o una anterior que no exige renovarse).
 */
CREATE OR REPLACE FUNCTION public.app_contract_enforcement_state(p_org uuid)
RETURNS TABLE (mode text, enforce_from timestamptz, satisfied boolean, pending integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH req AS (
    SELECT v.id AS version_id, v.document_id, v.requires_new_acceptance
      FROM public.contract_document_versions v JOIN public.contract_documents d ON d.id = v.document_id
     WHERE v.status = 'published' AND d.required_for_operation AND (d.organization_id IS NULL OR d.organization_id = p_org)
  ), missing AS (
    SELECT r.version_id FROM req r
     WHERE NOT EXISTS (SELECT 1 FROM public.organization_contract_acceptances a WHERE a.organization_id = p_org AND a.document_version_id = r.version_id)
       AND (r.requires_new_acceptance OR NOT EXISTS (
             SELECT 1 FROM public.organization_contract_acceptances a JOIN public.contract_document_versions pv ON pv.id = a.document_version_id
              WHERE a.organization_id = p_org AND pv.document_id = r.document_id))
  )
  SELECT coalesce(e.mode, 'off'), e.enforce_from, NOT EXISTS (SELECT 1 FROM missing), (SELECT count(*)::int FROM missing)
    FROM (SELECT 1) x LEFT JOIN public.organization_contract_enforcement e ON e.organization_id = p_org
$$;
REVOKE ALL ON FUNCTION public.app_contract_enforcement_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_enforcement_state(uuid) TO app_runtime;

-- ---------------------------------------------------------------- permisos y RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization_contract_signatories', 'contract_document_downloads', 'organization_contract_enforcement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['organization_contract_signatories', 'contract_document_downloads'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.app_contract_no_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;
GRANT UPDATE (legal_status, legal_approved_by_user_id, legal_approval_reference, source_file_name, source_file_sha256, commercial_terms)
  ON contract_document_versions TO app_runtime;
GRANT SELECT, INSERT ON organization_contract_signatories TO app_runtime;
GRANT UPDATE (revoked_by_user_id, revoke_reason) ON organization_contract_signatories TO app_runtime;
GRANT SELECT ON contract_document_downloads TO app_runtime;
GRANT INSERT (organization_id, document_version_id, user_id, format) ON contract_document_downloads TO app_runtime;
GRANT SELECT, INSERT, UPDATE (mode, enforce_from, reason, set_by_user_id, set_at) ON organization_contract_enforcement TO app_runtime;

-- Lectura con alcance: los documentos generales y los de la propia agencia (Orden de Suscripción).
DROP POLICY IF EXISTS contract_documents_read ON contract_documents;
CREATE POLICY contract_documents_read ON contract_documents FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (public.app_is_org_admin()
             AND (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
             AND EXISTS (SELECT 1 FROM contract_document_versions v
                          WHERE v.document_id = contract_documents.id AND v.status IN ('published', 'retired'))));
DROP POLICY IF EXISTS contract_document_versions_read ON contract_document_versions;
CREATE POLICY contract_document_versions_read ON contract_document_versions FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (status IN ('published', 'retired') AND public.app_is_org_admin()
             AND (public.app_contract_document_org(document_id) IS NULL
                  OR public.app_contract_document_org(document_id) = NULLIF(current_setting('app.current_org_id', true), '')::uuid)));

-- Representantes: Central designa y revoca; la administración de la agencia ve los suyos.
DROP POLICY IF EXISTS organization_contract_signatories_read ON organization_contract_signatories;
CREATE POLICY organization_contract_signatories_read ON organization_contract_signatories FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin()));
DROP POLICY IF EXISTS organization_contract_signatories_platform_insert ON organization_contract_signatories;
CREATE POLICY organization_contract_signatories_platform_insert ON organization_contract_signatories FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());
DROP POLICY IF EXISTS organization_contract_signatories_platform_update ON organization_contract_signatories;
CREATE POLICY organization_contract_signatories_platform_update ON organization_contract_signatories FOR UPDATE TO app_runtime
  USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());

-- Descargas: cada administradora registra las suyas en su agencia; la agencia las ve; Central no.
DROP POLICY IF EXISTS contract_document_downloads_own ON contract_document_downloads;
CREATE POLICY contract_document_downloads_own ON contract_document_downloads FOR INSERT TO app_runtime
  WITH CHECK (NOT app_is_superadmin()
              AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND public.app_is_org_admin());
DROP POLICY IF EXISTS contract_document_downloads_read ON contract_document_downloads;
CREATE POLICY contract_document_downloads_read ON contract_document_downloads FOR SELECT TO app_runtime
  USING (NOT app_is_superadmin()
         AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin());

-- Reglas de acceso: solo Central las fija; la administración de la agencia ve las suyas.
DROP POLICY IF EXISTS organization_contract_enforcement_read ON organization_contract_enforcement;
CREATE POLICY organization_contract_enforcement_read ON organization_contract_enforcement FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin()));
DROP POLICY IF EXISTS organization_contract_enforcement_platform_write ON organization_contract_enforcement;
CREATE POLICY organization_contract_enforcement_platform_write ON organization_contract_enforcement FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());
DROP POLICY IF EXISTS organization_contract_enforcement_platform_update ON organization_contract_enforcement;
CREATE POLICY organization_contract_enforcement_platform_update ON organization_contract_enforcement FOR UPDATE TO app_runtime
  USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());

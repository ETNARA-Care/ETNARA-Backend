-- 156: Contrato Oficial v1.1 — Word original inmutable, aprobación jurídica ligada al archivo y
-- términos individuales por función (Anexo E). 21-nov-2026. Preparación local; nada se publica.
-- Se apoya en 152 y 153 sin cambiar sus tablas de evidencia ni su lógica: añade dos tablas de
-- evidencia, una de archivos, una columna fijada por la base y un trigger que corre DESPUÉS de los
-- de 152/153 (orden alfabético: contract_document_versions_zz156_source_guard).
--
--   * Word original (.docx): se guarda una sola vez por versión, en la base, con su SHA-256 calculado
--     por la base. Debe coincidir con source_file_sha256 de la versión. No cambia ni se borra (ni el
--     superusuario, salvo la reversión de esta migración, que se niega con evidencia oficial). Solo
--     Central lo carga; la administración de la agencia lo descarga si puede ver esa versión; cada
--     descarga queda registrada (formato «docx»).
--   * Aprobación jurídica ligada al archivo: al aprobar, la base fija legal_approved_source_sha256 con
--     la huella del Word vigente. Un CONTRATO GENERAL oficial (SERVICE_AGREEMENT) solo se publica si:
--       - la referencia tiene la forma «Aprobado por: … | Fecha: AAAA-MM-DD | Referencia: …»;
--       - el Word original está guardado y su huella es la aprobada.
--     La base no completa ningún dato de la aprobación: los escribe Central.
--   * Términos por función: ETNARA Central crea versiones por función (ADMINISTRATION, CAREGIVER,
--     FAMILY) cuyo texto son LÍNEAS ÍNTEGRAS del contrato del que provienen (la base rechaza cualquier
--     línea que no exista tal cual en ese contrato: no se puede añadir ni redactar nada). Una versión
--     oficial solo se publica con su propia confirmación jurídica (referencia) sobre esa huella y si el
--     contrato fuente está aprobado jurídicamente. Cada persona acepta a su nombre, en su agencia, la
--     versión vigente de la función que realmente tiene; la evidencia no cambia ni se borra y una
--     versión nueva no sobrescribe las anteriores. No bloquea nada (no hay reglas de acceso aquí).
-- Idempotente. Reversión: ops/156_contract_source_files_role_terms.rollback.sql (se niega con
-- evidencia oficial).

-- ---------------------------------------------------------------- Word original
CREATE TABLE IF NOT EXISTS contract_source_files (
  document_version_id uuid PRIMARY KEY REFERENCES contract_document_versions(id),
  file_name           text NOT NULL CHECK (length(file_name) BETWEEN 6 AND 200 AND file_name ~* '\.docx$' AND file_name !~ '[/\\]'),
  content_type        text NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                      CHECK (content_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  byte_size           integer NOT NULL CHECK (byte_size BETWEEN 100 AND 10485760),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content             bytea NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.app_contract_source_file_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text; v_sha text; v_name text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'CONTRACT_SOURCE_FILE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  -- Un .docx es un ZIP: empieza con «PK\x03\x04».
  IF substring(NEW.content FROM 1 FOR 4) IS DISTINCT FROM '\x504b0304'::bytea THEN
    RAISE EXCEPTION 'CONTRACT_SOURCE_FILE_INVALID' USING ERRCODE = '22023';
  END IF;
  NEW.sha256 := encode(sha256(NEW.content), 'hex');
  NEW.byte_size := octet_length(NEW.content);
  NEW.content_type := 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  NEW.uploaded_at := now();
  SELECT v.status, v.source_file_sha256, v.source_file_name INTO v_status, v_sha, v_name
    FROM contract_document_versions v WHERE v.id = NEW.document_version_id;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  -- El archivo debe ser exactamente el declarado en la versión (nombre y huella).
  IF v_sha IS DISTINCT FROM NEW.sha256 OR v_name IS DISTINCT FROM NEW.file_name THEN
    RAISE EXCEPTION 'CONTRACT_SOURCE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_source_file_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_source_files_guard ON contract_source_files;
CREATE TRIGGER contract_source_files_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_source_files
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_source_file_guard();

-- Descargas: se admite el Word original.
ALTER TABLE contract_document_downloads DROP CONSTRAINT IF EXISTS contract_document_downloads_format_check;
ALTER TABLE contract_document_downloads ADD CONSTRAINT contract_document_downloads_format_check CHECK (format IN ('pdf', 'txt', 'docx'));

-- ---------------------------------------------------------------- aprobación jurídica ligada al Word
ALTER TABLE contract_document_versions ADD COLUMN IF NOT EXISTS legal_approved_source_sha256 text;
ALTER TABLE contract_document_versions DROP CONSTRAINT IF EXISTS contract_document_versions_legal_source_check;
ALTER TABLE contract_document_versions ADD CONSTRAINT contract_document_versions_legal_source_check
  CHECK (legal_approved_source_sha256 IS NULL OR legal_approved_source_sha256 ~ '^[0-9a-f]{64}$');

-- Forma obligatoria de la referencia de aprobación de un contrato general oficial.
CREATE OR REPLACE FUNCTION public.app_contract_legal_reference_complete(p_ref text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  -- (Las expresiones regulares de PostgreSQL admiten repeticiones de hasta 255: la longitud se mide aparte.)
  SELECT p_ref IS NOT NULL
     AND p_ref ~ '^Aprobado por: \S[^|]*\S \| Fecha: [0-9]{4}-[0-9]{2}-[0-9]{2} \| Referencia: \S[^|]*\S$'
     AND length(p_ref) BETWEEN 50 AND 520
$$;
REVOKE ALL ON FUNCTION public.app_contract_legal_reference_complete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_legal_reference_complete(text) TO app_runtime;

-- Sin RLS: ¿la versión tiene su Word guardado con esta huella?
CREATE OR REPLACE FUNCTION public.app_contract_source_file_stored(p_version uuid, p_sha text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM public.contract_source_files f WHERE f.document_version_id = p_version AND (p_sha IS NULL OR f.sha256 = p_sha)) $$;
REVOKE ALL ON FUNCTION public.app_contract_source_file_stored(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_source_file_stored(uuid, text) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_contract_version_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.legal_approved_source_sha256 := NULL;
    RETURN NEW;
  END IF;
  -- La fija la base: huella del Word en el momento de la aprobación jurídica.
  IF NEW.legal_status = 'legally_approved' AND OLD.legal_status IS DISTINCT FROM 'legally_approved' THEN
    NEW.legal_approved_source_sha256 := NEW.source_file_sha256;
  ELSIF NEW.legal_status = 'pending_legal_approval' THEN
    NEW.legal_approved_source_sha256 := NULL;
  ELSE
    NEW.legal_approved_source_sha256 := OLD.legal_approved_source_sha256;
  END IF;
  -- Con el Word ya guardado, su nombre y huella no cambian.
  IF (NEW.source_file_sha256 IS DISTINCT FROM OLD.source_file_sha256 OR NEW.source_file_name IS DISTINCT FROM OLD.source_file_name)
     AND public.app_contract_source_file_stored(NEW.id, NULL) THEN
    RAISE EXCEPTION 'CONTRACT_SOURCE_FILE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  -- Publicar un contrato general oficial: referencia completa y Word aprobado guardado.
  IF OLD.status = 'draft' AND NEW.status = 'published' AND NOT NEW.is_test
     AND public.app_contract_document_kind(NEW.document_id) = 'SERVICE_AGREEMENT' THEN
    IF NOT public.app_contract_legal_reference_complete(NEW.legal_approval_reference) THEN
      RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REFERENCE_INCOMPLETE' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_file_sha256 IS NULL OR NEW.legal_approved_source_sha256 IS DISTINCT FROM NEW.source_file_sha256
       OR NOT public.app_contract_source_file_stored(NEW.id, NEW.source_file_sha256) THEN
      RAISE EXCEPTION 'CONTRACT_SOURCE_FILE_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_version_source_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_document_versions_zz156_source_guard ON contract_document_versions;
CREATE TRIGGER contract_document_versions_zz156_source_guard
  BEFORE INSERT OR UPDATE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_version_source_guard();

-- ---------------------------------------------------------------- términos por función
CREATE TABLE IF NOT EXISTS role_terms_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role                       text NOT NULL CHECK (role IN ('ADMINISTRATION', 'CAREGIVER', 'FAMILY')),
  version_label              text NOT NULL CHECK (version_label ~ '^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$'),
  title                      text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  body                       text NOT NULL CHECK (length(body) BETWEEN 50 AND 50000),
  content_sha256             text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_contract_version_id uuid NOT NULL REFERENCES contract_document_versions(id),
  is_test                    boolean NOT NULL,
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  legal_status               text NOT NULL DEFAULT 'pending_legal_approval' CHECK (legal_status IN ('pending_legal_approval', 'legally_approved')),
  legal_approval_reference   text CHECK (legal_approval_reference IS NULL OR length(btrim(legal_approval_reference)) BETWEEN 10 AND 500),
  legal_approved_by_user_id  uuid REFERENCES users(id),
  legal_approved_at          timestamptz,
  legal_approved_sha256      text,
  created_by_user_id         uuid NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  published_at               timestamptz,
  published_by_user_id       uuid REFERENCES users(id),
  retired_at                 timestamptz,
  retired_by_user_id         uuid REFERENCES users(id),
  CONSTRAINT role_terms_versions_label_unique UNIQUE (role, version_label),
  CONSTRAINT role_terms_versions_state CHECK (
    (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL))
);
-- Como mucho una versión vigente por función.
CREATE UNIQUE INDEX IF NOT EXISTS role_terms_versions_one_published ON role_terms_versions (role) WHERE status = 'published';

-- Sin RLS: ¿cada línea del texto existe ÍNTEGRA en el contrato fuente? (no se puede redactar nada nuevo)
CREATE OR REPLACE FUNCTION public.app_role_terms_verbatim(p_body text, p_source uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH src AS (SELECT btrim(l) AS line FROM public.contract_document_versions v, regexp_split_to_table(v.body, '\n') l WHERE v.id = p_source)
  SELECT EXISTS (SELECT 1 FROM src)
     AND NOT EXISTS (SELECT 1 FROM regexp_split_to_table(p_body, '\n') b
                      WHERE btrim(b) <> '' AND btrim(b) NOT IN (SELECT line FROM src))
$$;
REVOKE ALL ON FUNCTION public.app_role_terms_verbatim(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_role_terms_verbatim(text, uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_role_terms_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_src_test boolean; v_src_kind text; v_src_legal text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ROLE_TERMS_IMMUTABLE' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  SELECT v.is_test, public.app_contract_document_kind(v.document_id), v.legal_status INTO v_src_test, v_src_kind, v_src_legal
    FROM contract_document_versions v WHERE v.id = NEW.source_contract_version_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'ROLE_TERMS_MUST_START_AS_DRAFT' USING ERRCODE = '22023'; END IF;
    IF v_src_kind IS DISTINCT FROM 'SERVICE_AGREEMENT' THEN RAISE EXCEPTION 'ROLE_TERMS_SOURCE_INVALID' USING ERRCODE = '22023'; END IF;
    NEW.is_test := v_src_test;
    NEW.legal_status := 'pending_legal_approval'; NEW.legal_approval_reference := NULL;
    NEW.legal_approved_by_user_id := NULL; NEW.legal_approved_at := NULL; NEW.legal_approved_sha256 := NULL;
    NEW.published_at := NULL; NEW.published_by_user_id := NULL; NEW.retired_at := NULL; NEW.retired_by_user_id := NULL;
    NEW.created_at := now(); NEW.updated_at := now();
  ELSE
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.source_contract_version_id IS DISTINCT FROM OLD.source_contract_version_id
       OR NEW.is_test IS DISTINCT FROM OLD.is_test OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'ROLE_TERMS_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'published' THEN
      -- Lo único posible: retirarla, sin tocar texto, huella ni aprobación.
      IF NEW.status <> 'retired' OR NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
         OR NEW.version_label IS DISTINCT FROM OLD.version_label OR NEW.legal_status IS DISTINCT FROM OLD.legal_status
         OR NEW.legal_approval_reference IS DISTINCT FROM OLD.legal_approval_reference OR NEW.legal_approved_by_user_id IS DISTINCT FROM OLD.legal_approved_by_user_id
         OR NEW.legal_approved_at IS DISTINCT FROM OLD.legal_approved_at OR NEW.legal_approved_sha256 IS DISTINCT FROM OLD.legal_approved_sha256
         OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
         OR NEW.retired_by_user_id IS NULL THEN
        RAISE EXCEPTION 'ROLE_TERMS_IMMUTABLE' USING ERRCODE = '42501';
      END IF;
      NEW.retired_at := now(); NEW.updated_at := now();
      NEW.content_sha256 := OLD.content_sha256;
      RETURN NEW;
    ELSIF OLD.status = 'retired' THEN
      RAISE EXCEPTION 'ROLE_TERMS_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    IF NEW.status NOT IN ('draft', 'published') THEN RAISE EXCEPTION 'ROLE_TERMS_INVALID_TRANSITION' USING ERRCODE = '22023'; END IF;
    NEW.updated_at := now();
  END IF;

  -- Texto: huella calculada por la base y solo líneas íntegras del contrato fuente.
  NEW.content_sha256 := public.app_contract_sha256(NEW.body);
  IF NOT public.app_role_terms_verbatim(NEW.body, NEW.source_contract_version_id) THEN
    RAISE EXCEPTION 'ROLE_TERMS_TEXT_NOT_IN_CONTRACT' USING ERRCODE = '22023';
  END IF;
  IF NEW.is_test AND NEW.body NOT LIKE 'DOCUMENTO FICTICIO DE PRUEBA%' THEN
    RAISE EXCEPTION 'CONTRACT_TEST_BANNER_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_test AND (NEW.body LIKE 'DOCUMENTO FICTICIO DE PRUEBA%' OR public.app_contract_text_signing_block(NEW.body) IS NOT NULL) THEN
    RAISE EXCEPTION 'CONTRACT_OFFICIAL_CANNOT_BE_MARKED_TEST' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Si el texto cambia en borrador, la confirmación jurídica se anula.
    IF NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.title IS DISTINCT FROM OLD.title OR NEW.version_label IS DISTINCT FROM OLD.version_label THEN
      IF NEW.legal_status = 'legally_approved' AND OLD.legal_status = 'legally_approved' THEN NEW.legal_status := 'pending_legal_approval'; END IF;
    END IF;
    IF NEW.legal_status = 'legally_approved' AND OLD.legal_status = 'pending_legal_approval' THEN
      IF NEW.legal_approval_reference IS NULL OR length(btrim(NEW.legal_approval_reference)) < 10 OR NEW.legal_approved_by_user_id IS NULL THEN
        RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REFERENCE_REQUIRED' USING ERRCODE = '22023';
      END IF;
      NEW.legal_approved_at := now();
      NEW.legal_approved_sha256 := NEW.content_sha256;
    ELSIF NEW.legal_status = 'pending_legal_approval' THEN
      NEW.legal_approval_reference := NULL; NEW.legal_approved_by_user_id := NULL; NEW.legal_approved_at := NULL; NEW.legal_approved_sha256 := NULL;
    ELSE
      NEW.legal_approved_at := OLD.legal_approved_at; NEW.legal_approved_sha256 := OLD.legal_approved_sha256;
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
      IF NEW.published_by_user_id IS NULL THEN RAISE EXCEPTION 'CONTRACT_PUBLISHER_REQUIRED' USING ERRCODE = '22023'; END IF;
      IF NOT NEW.is_test THEN
        IF NEW.legal_status <> 'legally_approved' OR NEW.legal_approved_sha256 IS DISTINCT FROM NEW.content_sha256 THEN
          RAISE EXCEPTION 'CONTRACT_LEGAL_APPROVAL_REQUIRED' USING ERRCODE = '42501';
        END IF;
        IF v_src_legal IS DISTINCT FROM 'legally_approved' THEN
          RAISE EXCEPTION 'ROLE_TERMS_SOURCE_NOT_APPROVED' USING ERRCODE = '42501';
        END IF;
      END IF;
      NEW.published_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_role_terms_version_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS role_terms_versions_guard ON role_terms_versions;
CREATE TRIGGER role_terms_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON role_terms_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_role_terms_version_guard();

-- Sin RLS: ¿esta persona tiene hoy, en esta agencia, la función de estos términos?
--   ADMINISTRATION: ORGANIZATION_ADMIN o SUPERVISOR · CAREGIVER: WORKER · FAMILY: FAMILY.
CREATE OR REPLACE FUNCTION public.app_role_terms_user_has_role(p_user uuid, p_org uuid, p_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
      JOIN public.organization_memberships om ON om.user_id = u.id AND om.organization_id = p_org AND om.status = 'active'
      JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
      JOIN public.roles r ON r.id = ur.role_id
     WHERE u.id = p_user AND u.status = 'active'
       AND r.code = ANY (CASE p_role WHEN 'ADMINISTRATION' THEN ARRAY['ORGANIZATION_ADMIN', 'SUPERVISOR']
                                     WHEN 'CAREGIVER' THEN ARRAY['WORKER']
                                     WHEN 'FAMILY' THEN ARRAY['FAMILY'] ELSE ARRAY[]::text[] END))
$$;
REVOKE ALL ON FUNCTION public.app_role_terms_user_has_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_role_terms_user_has_role(uuid, uuid, text) TO app_runtime;

-- Texto fijo de la casilla (lo guarda la base en cada evidencia).
CREATE OR REPLACE FUNCTION public.app_role_terms_checkbox_text()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 'He leído y acepto los términos individuales de mi función.'::text $$;
REVOKE ALL ON FUNCTION public.app_role_terms_checkbox_text() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_role_terms_checkbox_text() TO app_runtime;

CREATE TABLE IF NOT EXISTS user_role_terms_acceptances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  role                     text NOT NULL CHECK (role IN ('ADMINISTRATION', 'CAREGIVER', 'FAMILY')),
  terms_version_id         uuid NOT NULL REFERENCES role_terms_versions(id),
  content_sha256           text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  is_test                  boolean NOT NULL,
  accepted_login           text NOT NULL,
  acceptance_checkbox_text text NOT NULL,
  accepted_at              timestamptz NOT NULL DEFAULT now(),
  ip_address               inet,
  user_agent               text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  CONSTRAINT user_role_terms_acceptances_once UNIQUE (user_id, organization_id, terms_version_id)
);
CREATE INDEX IF NOT EXISTS user_role_terms_acceptances_org ON user_role_terms_acceptances (organization_id, accepted_at DESC);

CREATE OR REPLACE FUNCTION public.app_role_terms_acceptance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text; v_hash text; v_test boolean; v_role text; v_login text;
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ROLE_TERMS_ACCEPTANCE_IMMUTABLE' USING ERRCODE = '42501'; END IF;
  SELECT t.status, t.content_sha256, t.is_test, t.role INTO v_status, v_hash, v_test, v_role
    FROM role_terms_versions t WHERE t.id = NEW.terms_version_id;
  IF v_status IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'CONTRACT_VERSION_NOT_ACCEPTABLE' USING ERRCODE = '22023'; END IF;
  IF NEW.content_sha256 IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'CONTRACT_CONTENT_MISMATCH' USING ERRCODE = '22023'; END IF;
  IF NOT public.app_role_terms_user_has_role(NEW.user_id, NEW.organization_id, v_role) THEN
    RAISE EXCEPTION 'ROLE_TERMS_ROLE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'app_runtime' OR session_user = 'app_runtime' THEN
    -- Solo a nombre propio y nunca desde el contexto de ETNARA Central.
    IF v_actor IS NULL OR v_actor <> NEW.user_id OR app_is_superadmin() THEN
      RAISE EXCEPTION 'ROLE_TERMS_ROLE_MISMATCH' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT COALESCE(u.email, u.phone) INTO v_login FROM users u WHERE u.id = NEW.user_id;
  NEW.role := v_role;
  NEW.is_test := v_test;
  NEW.accepted_login := v_login;
  NEW.acceptance_checkbox_text := public.app_role_terms_checkbox_text();
  NEW.accepted_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_role_terms_acceptance_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS user_role_terms_acceptances_guard ON user_role_terms_acceptances;
CREATE TRIGGER user_role_terms_acceptances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON user_role_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.app_role_terms_acceptance_guard();

-- TRUNCATE no dispara los triggers por fila.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_source_files', 'role_terms_versions', 'user_role_terms_acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.app_contract_no_truncate()', t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- permisos de la aplicación (RLS)
GRANT SELECT ON contract_source_files TO app_runtime;
GRANT INSERT (document_version_id, file_name, content, uploaded_by_user_id) ON contract_source_files TO app_runtime;
GRANT SELECT, INSERT ON role_terms_versions TO app_runtime;
GRANT UPDATE (title, body, version_label, status, legal_status, legal_approval_reference, legal_approved_by_user_id, published_by_user_id, retired_by_user_id)
  ON role_terms_versions TO app_runtime;
GRANT DELETE ON role_terms_versions TO app_runtime;
GRANT SELECT ON user_role_terms_acceptances TO app_runtime;
GRANT INSERT (user_id, organization_id, terms_version_id, content_sha256, ip_address, user_agent) ON user_role_terms_acceptances TO app_runtime;

-- Word original: lo ve quien puede ver esa versión (las políticas de contract_document_versions
-- se aplican dentro de la subconsulta); solo Central lo carga.
DROP POLICY IF EXISTS contract_source_files_read ON contract_source_files;
CREATE POLICY contract_source_files_read ON contract_source_files FOR SELECT TO app_runtime
  USING (EXISTS (SELECT 1 FROM contract_document_versions v WHERE v.id = contract_source_files.document_version_id));
DROP POLICY IF EXISTS contract_source_files_platform_insert ON contract_source_files;
CREATE POLICY contract_source_files_platform_insert ON contract_source_files FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());

-- Términos por función: Central los administra; lo vigente o retirado lo lee cualquier persona con sesión.
DROP POLICY IF EXISTS role_terms_versions_read ON role_terms_versions;
CREATE POLICY role_terms_versions_read ON role_terms_versions FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (status IN ('published', 'retired') AND NULLIF(current_setting('app.current_user_id', true), '') IS NOT NULL));
DROP POLICY IF EXISTS role_terms_versions_platform_insert ON role_terms_versions;
CREATE POLICY role_terms_versions_platform_insert ON role_terms_versions FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());
DROP POLICY IF EXISTS role_terms_versions_platform_update ON role_terms_versions;
CREATE POLICY role_terms_versions_platform_update ON role_terms_versions FOR UPDATE TO app_runtime
  USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());
DROP POLICY IF EXISTS role_terms_versions_platform_delete ON role_terms_versions;
CREATE POLICY role_terms_versions_platform_delete ON role_terms_versions FOR DELETE TO app_runtime
  USING (app_is_superadmin() AND status = 'draft');

-- Evidencia: cada persona ve la suya; la administración de la agencia ve la de su agencia; Central todas.
DROP POLICY IF EXISTS user_role_terms_acceptances_read ON user_role_terms_acceptances;
CREATE POLICY user_role_terms_acceptances_read ON user_role_terms_acceptances FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         OR (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin()));
DROP POLICY IF EXISTS user_role_terms_acceptances_own_insert ON user_role_terms_acceptances;
CREATE POLICY user_role_terms_acceptances_own_insert ON user_role_terms_acceptances FOR INSERT TO app_runtime
  WITH CHECK (NOT app_is_superadmin()
              AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

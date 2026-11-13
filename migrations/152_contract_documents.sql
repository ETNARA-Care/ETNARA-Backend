-- 152: módulo contractual, Etapa 1 (9-nov-2026). Desarrollo local; sin contrato oficial publicado.
--
-- ETNARA Central publica documentos contractuales (acuerdo de servicio, términos, privacidad,
-- tratamiento de datos…) en VERSIONES. La administración de cada agencia acepta una versión
-- publicada y queda una EVIDENCIA inalterable: qué texto exacto (huella SHA-256 calculada por la
-- base), qué agencia, qué usuaria, con qué rol y cuándo (hora del servidor).
--
-- Reglas que la base garantiza (también para el superusuario, salvo la reversión de esta migración):
--   * una versión publicada o retirada no cambia nunca: ni texto, ni huella, ni etiqueta, ni fechas;
--     solo puede pasar de «publicada» a «retirada»; ninguna se borra;
--   * la huella la calcula la base a partir del texto; nadie la escribe a mano;
--   * una aceptación no se modifica ni se borra; solo se acepta una versión publicada y solo si la
--     huella enviada coincide con la del texto (la usuaria aceptó exactamente lo que vio);
--   * la aceptación identifica a la REPRESENTANTE AUTORIZADA: nombre completo, cargo y la declaración
--     expresa de autoridad (texto fijo que pone la base; la aplicación solo confirma que se aceptó);
--   * los documentos de PRUEBA están marcados (is_test, código TEST_, título «[PRUEBA]», texto que
--     empieza con «DOCUMENTO FICTICIO DE PRUEBA»); un documento oficial no puede usar esas marcas.
-- Permisos para la aplicación (app_runtime, RLS):
--   * solo ETNARA Central (superadministración de plataforma) crea documentos y versiones, edita
--     borradores, publica y retira; Central NO puede aceptar en nombre de una agencia;
--   * solo una ORGANIZATION_ADMIN activa acepta, en su propia agencia y a su propio nombre;
--   * cada agencia ve sus aceptaciones y nunca las de otra; Central ve las de todas (es su ámbito:
--     suscripciones y contratos), pero no datos de residentes ni del personal.
-- Etapa 2 (local): antes de firmar, la representante confirma un CÓDIGO enviado al correo de su
-- cuenta (contract_signature_challenges). Cada aceptación queda ligada a un único código consumido
-- (método EMAIL_CODE y correo de destino fijados por la base). Cada versión indica si exige una
-- nueva aceptación de quien ya aceptó la anterior.
-- No bloquea nada: ninguna operación de la agencia depende todavía de haber aceptado.
-- Idempotente. Reversión: ops/152_contract_documents.rollback.sql — se NIEGA a ejecutarse si existe
-- alguna evidencia o versión publicada de un documento oficial (no de prueba): esa evidencia no se
-- elimina con una reversión ordinaria.

-- ---------------------------------------------------------------- tablas
CREATE TABLE IF NOT EXISTS contract_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  title              text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  kind               text NOT NULL CHECK (kind IN ('SERVICE_AGREEMENT', 'TERMS_OF_USE', 'PRIVACY_NOTICE',
                                                   'DATA_PROCESSING', 'BUSINESS_ASSOCIATE', 'OTHER')),
  is_test            boolean NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Un documento de prueba se reconoce a simple vista; uno oficial no puede parecer de prueba.
  CONSTRAINT contract_documents_test_marking CHECK (
    (is_test AND code LIKE 'TEST\_%' AND title LIKE '[PRUEBA]%')
    OR (NOT is_test AND code NOT LIKE 'TEST\_%' AND title NOT LIKE '[PRUEBA]%'))
);

CREATE TABLE IF NOT EXISTS contract_document_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          uuid NOT NULL REFERENCES contract_documents(id),
  version_label        text NOT NULL CHECK (version_label ~ '^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$'),
  body                 text NOT NULL CHECK (length(body) BETWEEN 50 AND 200000),
  content_sha256       text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  is_test              boolean NOT NULL,
  -- Si quien aceptó una versión anterior del mismo documento debe aceptar esta (cambios sustanciales).
  requires_new_acceptance boolean NOT NULL DEFAULT true,
  created_by_user_id   uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz,
  published_by_user_id uuid REFERENCES users(id),
  retired_at           timestamptz,
  retired_by_user_id   uuid REFERENCES users(id),
  CONSTRAINT contract_document_versions_label_unique UNIQUE (document_id, version_label),
  CONSTRAINT contract_document_versions_state CHECK (
    (status = 'draft' AND published_at IS NULL AND published_by_user_id IS NULL AND retired_at IS NULL AND retired_by_user_id IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL AND retired_at IS NULL AND retired_by_user_id IS NULL)
    OR (status = 'retired' AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL AND retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL))
);
-- Como mucho una versión vigente por documento.
CREATE UNIQUE INDEX IF NOT EXISTS contract_document_versions_one_published
  ON contract_document_versions (document_id) WHERE status = 'published';

-- Verificación adicional de identidad: un código de 6 dígitos enviado al correo de la cuenta.
-- Solo se guarda su huella. Vence a los 10 minutos, admite 5 intentos y se usa una sola vez.
CREATE TABLE IF NOT EXISTS contract_signature_challenges (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  document_version_id uuid NOT NULL REFERENCES contract_document_versions(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  email               text NOT NULL,
  code_hash           text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  delivery_status     text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz
);
CREATE INDEX IF NOT EXISTS contract_signature_challenges_user_version
  ON contract_signature_challenges (user_id, document_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_contract_acceptances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  document_version_id  uuid NOT NULL REFERENCES contract_document_versions(id),
  content_sha256       text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  is_test              boolean NOT NULL,
  accepted_by_user_id  uuid NOT NULL REFERENCES users(id),
  -- Instantáneas fijadas por la base en el momento de aceptar (no las escribe la aplicación).
  accepted_by_login    text NOT NULL,
  accepted_role        text NOT NULL CHECK (accepted_role = 'ORGANIZATION_ADMIN'),
  -- Representante autorizada (la escribe ella; nombre y apellido como mínimo).
  signer_full_name     text NOT NULL CHECK (length(btrim(signer_full_name)) BETWEEN 5 AND 150 AND btrim(signer_full_name) ~ '\S+\s+\S+'),
  signer_title         text NOT NULL CHECK (length(btrim(signer_title)) BETWEEN 2 AND 100),
  -- Declaración expresa de autoridad: texto fijo que pone la base (ver app_contract_authority_declaration).
  authority_declaration text NOT NULL,
  organization_name    text NOT NULL,
  acceptance_statement text NOT NULL CHECK (length(acceptance_statement) BETWEEN 20 AND 1000),
  accepted_at          timestamptz NOT NULL DEFAULT now(),
  ip_address           inet,
  user_agent           text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  -- Etapa 2: verificación de identidad usada (un código consumido, una sola vez) y correo de destino.
  verification_challenge_id uuid NOT NULL UNIQUE REFERENCES contract_signature_challenges(id),
  verification_method  text NOT NULL CHECK (verification_method = 'EMAIL_CODE'),
  verified_email       text NOT NULL,
  CONSTRAINT organization_contract_acceptances_once UNIQUE (organization_id, document_version_id)
);
CREATE INDEX IF NOT EXISTS organization_contract_acceptances_version
  ON organization_contract_acceptances (document_version_id);

-- ---------------------------------------------------------------- integridad e inmutabilidad
CREATE OR REPLACE FUNCTION public.app_contract_sha256(p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT encode(sha256(convert_to(p_body, 'UTF8')), 'hex') $$;
REVOKE ALL ON FUNCTION public.app_contract_sha256(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_sha256(text) TO app_runtime;

-- Texto fijo de la declaración de autoridad (lo guarda la base en cada evidencia).
CREATE OR REPLACE FUNCTION public.app_contract_authority_declaration()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 'Declaro que tengo autoridad suficiente para aceptar este documento en nombre de la organización y obligarla a sus términos, y que mi nombre y cargo son verdaderos.'::text $$;
REVOKE ALL ON FUNCTION public.app_contract_authority_declaration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_authority_declaration() TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_contract_document_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- El catálogo es historial: un documento no cambia ni se borra (sus versiones lo referencian).
  RAISE EXCEPTION 'CONTRACT_DOCUMENT_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_document_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_documents_immutable ON contract_documents;
CREATE TRIGGER contract_documents_immutable
  BEFORE UPDATE OR DELETE ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_document_guard();

CREATE OR REPLACE FUNCTION public.app_contract_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_is_test boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'CONTRACT_VERSION_MUST_START_AS_DRAFT' USING ERRCODE = '22023';
    END IF;
    SELECT d.is_test INTO v_is_test FROM contract_documents d WHERE d.id = NEW.document_id;
    NEW.is_test := v_is_test;
    NEW.published_at := NULL; NEW.published_by_user_id := NULL;
    NEW.retired_at := NULL; NEW.retired_by_user_id := NULL;
    NEW.created_at := now(); NEW.updated_at := now();
  ELSE
    -- Nunca cambian: a qué documento pertenece, quién la creó, si es de prueba.
    IF NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.is_test IS DISTINCT FROM OLD.is_test
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'draft' THEN
      IF NEW.status = 'published' THEN
        NEW.published_at := now();
        IF NEW.published_by_user_id IS NULL THEN
          RAISE EXCEPTION 'CONTRACT_PUBLISHER_REQUIRED' USING ERRCODE = '22023';
        END IF;
      ELSIF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'CONTRACT_VERSION_INVALID_TRANSITION' USING ERRCODE = '22023';
      END IF;
      NEW.updated_at := now();
    ELSIF OLD.status = 'published' THEN
      -- Lo único posible: retirarla. Texto, huella, etiqueta y publicación quedan intactos.
      IF NEW.status <> 'retired' OR NEW.body IS DISTINCT FROM OLD.body OR NEW.version_label IS DISTINCT FROM OLD.version_label
         OR NEW.requires_new_acceptance IS DISTINCT FROM OLD.requires_new_acceptance
         OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.published_at IS DISTINCT FROM OLD.published_at
         OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id OR NEW.retired_by_user_id IS NULL THEN
        RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
      END IF;
      NEW.retired_at := now(); NEW.updated_at := now();
    ELSE
      RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- La huella siempre la calcula la base a partir del texto guardado.
  NEW.content_sha256 := public.app_contract_sha256(NEW.body);
  IF NEW.is_test AND NEW.body NOT LIKE 'DOCUMENTO FICTICIO DE PRUEBA%' THEN
    RAISE EXCEPTION 'CONTRACT_TEST_BANNER_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.is_test AND NEW.body LIKE 'DOCUMENTO FICTICIO DE PRUEBA%' THEN
    RAISE EXCEPTION 'CONTRACT_OFFICIAL_CANNOT_BE_MARKED_TEST' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_version_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_document_versions_guard ON contract_document_versions;
CREATE TRIGGER contract_document_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_version_guard();

-- Datos que fija la base en la evidencia (la aplicación no los puede falsear).
CREATE OR REPLACE FUNCTION public.app_contract_acceptance_facts(p_user uuid, p_org uuid)
RETURNS TABLE (login text, organization_name text, is_active_admin boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(u.email, u.phone),
         o.name,
         EXISTS (SELECT 1 FROM public.organization_memberships om
                   JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                   JOIN public.roles r ON r.id = ur.role_id AND r.code = 'ORGANIZATION_ADMIN'
                  WHERE om.user_id = p_user AND om.organization_id = p_org AND om.status = 'active')
         AND u.status = 'active'
    FROM public.users u, public.organizations o
   WHERE u.id = p_user AND o.id = p_org
$$;
REVOKE ALL ON FUNCTION public.app_contract_acceptance_facts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_acceptance_facts(uuid, uuid) TO app_runtime;

-- Correo de la cuenta (destino del código de firma).
CREATE OR REPLACE FUNCTION public.app_contract_user_email(p_user uuid)
RETURNS TABLE (email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT u.email FROM public.users u WHERE u.id = p_user AND u.status = 'active' AND u.email IS NOT NULL $$;
REVOKE ALL ON FUNCTION public.app_contract_user_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_contract_user_email(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_contract_challenge_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_login text;
  v_admin boolean;
  v_status text;
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONTRACT_CHALLENGE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT v.status INTO v_status FROM contract_document_versions v WHERE v.id = NEW.document_version_id;
    IF v_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'CONTRACT_VERSION_NOT_ACCEPTABLE' USING ERRCODE = '22023';
    END IF;
    SELECT f.is_active_admin INTO v_admin FROM public.app_contract_acceptance_facts(NEW.user_id, NEW.organization_id) f;
    IF NOT COALESCE(v_admin, false) THEN
      RAISE EXCEPTION 'CONTRACT_ACCEPTANCE_ADMIN_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF (current_user = 'app_runtime' OR session_user = 'app_runtime') AND (v_actor IS NULL OR v_actor <> NEW.user_id OR app_is_superadmin()) THEN
      RAISE EXCEPTION 'CONTRACT_ACCEPTANCE_ADMIN_REQUIRED' USING ERRCODE = '42501';
    END IF;
    -- El destino es el correo de la cuenta, nunca uno que escriba la aplicación.
    SELECT u.email INTO v_login FROM public.app_contract_user_email(NEW.user_id) u;
    IF v_login IS NULL THEN
      RAISE EXCEPTION 'CONTRACT_SIGNER_EMAIL_REQUIRED' USING ERRCODE = '22023';
    END IF;
    NEW.email := v_login;
    NEW.delivery_status := 'pending';
    NEW.attempts := 0;
    NEW.consumed_at := NULL;
    NEW.created_at := now();
    NEW.expires_at := now() + interval '10 minutes';
    RETURN NEW;
  END IF;
  -- UPDATE: solo sumar un intento, marcar el envío o consumirlo una vez (antes de vencer).
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.document_version_id <> OLD.document_version_id
     OR NEW.user_id <> OLD.user_id OR NEW.email <> OLD.email OR NEW.code_hash <> OLD.code_hash
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.attempts NOT IN (OLD.attempts, OLD.attempts + 1)
     OR (OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
     OR (OLD.delivery_status <> 'pending' AND NEW.delivery_status <> OLD.delivery_status) THEN
    RAISE EXCEPTION 'CONTRACT_CHALLENGE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL THEN
    IF OLD.expires_at <= now() OR OLD.delivery_status <> 'sent' OR OLD.attempts >= 5 THEN
      RAISE EXCEPTION 'CONTRACT_CODE_NOT_USABLE' USING ERRCODE = '22023';
    END IF;
    NEW.consumed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_challenge_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS contract_signature_challenges_guard ON contract_signature_challenges;
CREATE TRIGGER contract_signature_challenges_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_signature_challenges
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_challenge_guard();

CREATE OR REPLACE FUNCTION public.app_contract_acceptance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_hash text;
  v_is_test boolean;
  v_login text;
  v_org_name text;
  v_admin boolean;
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- La evidencia es definitiva: nadie la cambia ni la borra.
    RAISE EXCEPTION 'CONTRACT_ACCEPTANCE_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  SELECT v.status, v.content_sha256, v.is_test INTO v_status, v_hash, v_is_test
    FROM contract_document_versions v WHERE v.id = NEW.document_version_id;
  IF v_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_NOT_ACCEPTABLE' USING ERRCODE = '22023';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'CONTRACT_CONTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  SELECT f.login, f.organization_name, f.is_active_admin INTO v_login, v_org_name, v_admin
    FROM public.app_contract_acceptance_facts(NEW.accepted_by_user_id, NEW.organization_id) f;
  IF NOT COALESCE(v_admin, false) THEN
    RAISE EXCEPTION 'CONTRACT_ACCEPTANCE_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'app_runtime' OR session_user = 'app_runtime' THEN
    -- Solo a nombre propio y nunca desde el contexto de ETNARA Central.
    IF v_actor IS NULL OR v_actor <> NEW.accepted_by_user_id OR app_is_superadmin() THEN
      RAISE EXCEPTION 'CONTRACT_ACCEPTANCE_ADMIN_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.is_test := v_is_test;
  NEW.accepted_by_login := v_login;
  NEW.organization_name := v_org_name;
  -- Etapa 2: un código del correo de la cuenta, de esta misma persona, agencia y versión, recién
  -- consumido (15 min como máximo) y nunca usado por otra aceptación (UNIQUE).
  SELECT c.email INTO v_login
    FROM contract_signature_challenges c
   WHERE c.id = NEW.verification_challenge_id AND c.user_id = NEW.accepted_by_user_id
     AND c.organization_id = NEW.organization_id AND c.document_version_id = NEW.document_version_id
     AND c.delivery_status = 'sent' AND c.consumed_at IS NOT NULL AND c.consumed_at > now() - interval '15 minutes';
  IF v_login IS NULL THEN
    RAISE EXCEPTION 'CONTRACT_IDENTITY_NOT_VERIFIED' USING ERRCODE = '42501';
  END IF;
  NEW.verified_email := v_login;
  NEW.verification_method := 'EMAIL_CODE';
  NEW.accepted_role := 'ORGANIZATION_ADMIN';
  NEW.authority_declaration := public.app_contract_authority_declaration();
  NEW.signer_full_name := btrim(NEW.signer_full_name);
  NEW.signer_title := btrim(NEW.signer_title);
  NEW.accepted_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_acceptance_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS organization_contract_acceptances_guard ON organization_contract_acceptances;
CREATE TRIGGER organization_contract_acceptances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON organization_contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.app_contract_acceptance_guard();

-- TRUNCATE no dispara los triggers por fila: se cierra aparte.
CREATE OR REPLACE FUNCTION public.app_contract_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$ BEGIN RAISE EXCEPTION 'CONTRACT_HISTORY_IMMUTABLE' USING ERRCODE = '42501'; END; $$;
REVOKE ALL ON FUNCTION public.app_contract_no_truncate() FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_documents', 'contract_document_versions', 'contract_signature_challenges', 'organization_contract_acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.app_contract_no_truncate()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- permisos de la aplicación (RLS)
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_contract_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signature_challenges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON contract_documents, contract_document_versions, organization_contract_acceptances, contract_signature_challenges FROM PUBLIC;
REVOKE ALL ON contract_documents, contract_document_versions, organization_contract_acceptances, contract_signature_challenges FROM app_runtime;
GRANT SELECT, INSERT ON contract_documents TO app_runtime;
GRANT SELECT, INSERT ON contract_document_versions TO app_runtime;
GRANT UPDATE (body, version_label, requires_new_acceptance, status, published_by_user_id, retired_by_user_id) ON contract_document_versions TO app_runtime;
GRANT SELECT ON contract_signature_challenges TO app_runtime;
GRANT INSERT (id, organization_id, document_version_id, user_id, code_hash) ON contract_signature_challenges TO app_runtime;
GRANT UPDATE (attempts, delivery_status, consumed_at) ON contract_signature_challenges TO app_runtime;
GRANT SELECT ON organization_contract_acceptances TO app_runtime;
GRANT INSERT (organization_id, document_version_id, content_sha256, accepted_by_user_id, signer_full_name, signer_title, acceptance_statement, ip_address, user_agent, verification_challenge_id)
  ON organization_contract_acceptances TO app_runtime;

-- Catálogo: Central lo administra; la administración de una agencia ve lo publicado (y lo retirado,
-- para su historial). Nadie más.
DROP POLICY IF EXISTS contract_documents_read ON contract_documents;
CREATE POLICY contract_documents_read ON contract_documents FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (public.app_is_org_admin() AND EXISTS (
               SELECT 1 FROM contract_document_versions v
                WHERE v.document_id = contract_documents.id AND v.status IN ('published', 'retired'))));
DROP POLICY IF EXISTS contract_documents_platform_insert ON contract_documents;
CREATE POLICY contract_documents_platform_insert ON contract_documents FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());

DROP POLICY IF EXISTS contract_document_versions_read ON contract_document_versions;
CREATE POLICY contract_document_versions_read ON contract_document_versions FOR SELECT TO app_runtime
  USING (app_is_superadmin() OR (status IN ('published', 'retired') AND public.app_is_org_admin()));
DROP POLICY IF EXISTS contract_document_versions_platform_insert ON contract_document_versions;
CREATE POLICY contract_document_versions_platform_insert ON contract_document_versions FOR INSERT TO app_runtime
  WITH CHECK (app_is_superadmin());
DROP POLICY IF EXISTS contract_document_versions_platform_update ON contract_document_versions;
CREATE POLICY contract_document_versions_platform_update ON contract_document_versions FOR UPDATE TO app_runtime
  USING (app_is_superadmin()) WITH CHECK (app_is_superadmin());

-- Evidencia: la agencia ve solo la suya; Central ve todas pero no acepta.
DROP POLICY IF EXISTS organization_contract_acceptances_read ON organization_contract_acceptances;
CREATE POLICY organization_contract_acceptances_read ON organization_contract_acceptances FOR SELECT TO app_runtime
  USING (app_is_superadmin()
         OR (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin()));
DROP POLICY IF EXISTS organization_contract_acceptances_admin_insert ON organization_contract_acceptances;
CREATE POLICY organization_contract_acceptances_admin_insert ON organization_contract_acceptances FOR INSERT TO app_runtime
  WITH CHECK (NOT app_is_superadmin()
              AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
              AND accepted_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
              AND public.app_is_org_admin());

-- Códigos de firma: solo la propia representante, en su agencia y fuera del contexto de Central.
-- Central no los ve (no los necesita para consultar quién aceptó).
DROP POLICY IF EXISTS contract_signature_challenges_own ON contract_signature_challenges;
CREATE POLICY contract_signature_challenges_own ON contract_signature_challenges FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()
         AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_is_org_admin())
  WITH CHECK (NOT app_is_superadmin()
         AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND public.app_is_org_admin());

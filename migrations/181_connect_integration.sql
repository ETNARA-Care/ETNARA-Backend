-- 181: integración con ETNARA Connect — vínculo de cuentas, estado firmado y aviso inmediato (28-nov-2026).
-- Rama aparte (integracion-connect), aprobada por Rafa el 28-nov-2026 (C-2, C-3). Nada se despliega sin su autorización.
--
-- Principios (claude/integracion-care-connect-diseno-2026-11-28.md):
--   * Bases INDEPENDIENTES: Connect nunca lee esta base. Solo recibe mensajes firmados por Care (Ed25519, la llave vive
--     en el servidor, nunca aquí) y llama a dos rutas de servidor a servidor.
--   * Cuentas VINCULADAS, no duplicadas: una organización de Care se vincula a UN solo proveedor de Connect (y al revés).
--     El vínculo nace de un código de un solo uso (10 min) que crea la administración de la organización.
--   * El inicio de sesión de Care NO cambia.
--   * Aviso INMEDIATO: cuando una organización vinculada cambia de estado (suspensión, reactivación, archivo) o se
--     desvincula, un disparador deja el evento en una bandeja de salida en la MISMA transacción; el servidor lo entrega
--     a Connect (con reintentos). Connect además consulta el estado (respaldo), sin depender solo de eso.
--   * Datos mínimos: tipo, si está activa o suspendida y el estado contractual. Nunca personas, residentes ni montos.
-- Idempotente. Reversión: ops/181_connect_integration.rollback.sql.

CREATE TABLE IF NOT EXISTS connect_link_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  code_sha256         text NOT NULL UNIQUE CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id  uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  redeemed_at         timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_connect_link_codes_org ON connect_link_codes (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connect_links (
  organization_id      uuid PRIMARY KEY REFERENCES organizations(id),
  connect_provider_ref text NOT NULL CHECK (connect_provider_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  linked_at            timestamptz NOT NULL DEFAULT now(),
  linked_by_code       uuid NOT NULL REFERENCES connect_link_codes(id),
  revoked_at           timestamptz,
  revoked_by_user_id   uuid REFERENCES users(id),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
-- Un proveedor de Connect vinculado (vigente) a una sola organización.
CREATE UNIQUE INDEX IF NOT EXISTS uq_connect_links_ref_active ON connect_links (connect_provider_ref) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS connect_outbox (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  event_type       text NOT NULL CHECK (event_type IN ('ORG_STATUS_CHANGED', 'LINK_REVOKED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  last_status      integer
);
CREATE INDEX IF NOT EXISTS idx_connect_outbox_pending ON connect_outbox (next_attempt_at) WHERE delivered_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connect_link_codes', 'connect_links', 'connect_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
    -- Sin acceso directo de la aplicación: solo las funciones SECURITY DEFINER de abajo.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_definer', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (current_user <> ''app_runtime'') WITH CHECK (current_user <> ''app_runtime'')', t || '_definer', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE connect_outbox_id_seq FROM PUBLIC;

-- ---------------------------------------------------------------- hechos de la organización (sin datos personales)
CREATE OR REPLACE FUNCTION public.app_connect_org_facts(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'organizationId', o.id,
    'type', CASE o.organization_type::text WHEN 'INDEPENDENT_PROVIDER' THEN 'independiente'
                                           WHEN 'RESIDENTIAL_CARE_HOME' THEN 'hogar' ELSE 'agencia' END,
    'active', o.status::text IN ('trial', 'active') AND o.archived_at IS NULL,
    'suspended', o.status::text = 'suspended' OR o.archived_at IS NOT NULL,
    'contractSatisfied', coalesce((SELECT s.satisfied FROM public.app_contract_enforcement_state(o.id) s), false),
    'subscriptionOrder', EXISTS (
      SELECT 1 FROM public.organization_contract_acceptances a
        JOIN public.contract_document_versions v ON v.id = a.document_version_id
        JOIN public.contract_documents d ON d.id = v.document_id
       WHERE a.organization_id = o.id AND d.kind = 'SUBSCRIPTION_ORDER' AND v.status = 'published' AND NOT a.is_test),
    'connectProviderRef', (SELECT l.connect_provider_ref FROM public.connect_links l WHERE l.organization_id = o.id AND l.revoked_at IS NULL))
  FROM public.organizations o WHERE o.id = p_org
$$;
REVOKE ALL ON FUNCTION public.app_connect_org_facts(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------- administración de la organización (contexto de tenant)
-- Crea un código de un solo uso (el servidor genera el código y solo pasa su huella). Invalida los anteriores sin usar.
CREATE OR REPLACE FUNCTION public.app_connect_create_link_code(p_code_sha256 text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
        v_exp timestamptz := now() + interval '10 minutes';
BEGIN
  IF NOT public.app_is_org_admin() THEN RAISE EXCEPTION 'CONNECT_ORG_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF (SELECT status::text FROM public.organizations WHERE id = v_org) = 'suspended' THEN
    RAISE EXCEPTION 'CONNECT_ORG_SUSPENDED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.connect_link_codes SET expires_at = least(expires_at, now() + interval '1 second') WHERE organization_id = v_org AND redeemed_at IS NULL AND expires_at > now();
  INSERT INTO public.connect_link_codes (organization_id, code_sha256, created_by_user_id, expires_at) VALUES (v_org, p_code_sha256, v_user, v_exp);
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
    VALUES (v_user, v_org, 'CONNECT_LINK_CODE_CREATED', 'organization', v_org);
  RETURN v_exp;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_create_link_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_create_link_code(text) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_connect_link_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
BEGIN
  IF NOT public.app_is_org_admin() THEN RAISE EXCEPTION 'CONNECT_ORG_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN (SELECT jsonb_build_object('linked', l.organization_id IS NOT NULL, 'linkedAt', l.linked_at)
            FROM (SELECT 1) x LEFT JOIN public.connect_links l ON l.organization_id = v_org AND l.revoked_at IS NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_link_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_link_status() TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_connect_unlink()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF NOT public.app_is_org_admin() THEN RAISE EXCEPTION 'CONNECT_ORG_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  UPDATE public.connect_links SET revoked_at = now(), revoked_by_user_id = v_user WHERE organization_id = v_org AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONNECT_NOT_LINKED' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.connect_outbox (organization_id, event_type) VALUES (v_org, 'LINK_REVOKED');
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
    VALUES (v_user, v_org, 'CONNECT_UNLINKED', 'organization', v_org);
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_unlink() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_unlink() TO app_runtime;

-- ---------------------------------------------------------------- servidor a servidor (sin persona; el servidor autentica a Connect)
-- Canjea el código (una vez, sin vencer) y vincula la organización a ese proveedor de Connect. Evita duplicados en los
-- dos sentidos: ni la organización ni el proveedor pueden quedar vinculados dos veces.
CREATE OR REPLACE FUNCTION public.app_connect_redeem_link_code(p_code_sha256 text, p_connect_provider_ref text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE c public.connect_link_codes%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.connect_link_codes WHERE code_sha256 = p_code_sha256 FOR UPDATE;
  IF NOT FOUND OR c.redeemed_at IS NOT NULL OR c.expires_at <= now() THEN
    RAISE EXCEPTION 'CONNECT_CODE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  IF (SELECT status::text FROM public.organizations WHERE id = c.organization_id) = 'suspended' THEN
    RAISE EXCEPTION 'CONNECT_ORG_SUSPENDED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connect_links WHERE connect_provider_ref = p_connect_provider_ref AND revoked_at IS NULL AND organization_id <> c.organization_id) THEN
    RAISE EXCEPTION 'CONNECT_PROVIDER_ALREADY_LINKED' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connect_links WHERE organization_id = c.organization_id AND revoked_at IS NULL AND connect_provider_ref <> p_connect_provider_ref) THEN
    RAISE EXCEPTION 'CONNECT_ORG_ALREADY_LINKED' USING ERRCODE = '23505';
  END IF;
  UPDATE public.connect_link_codes SET redeemed_at = now() WHERE id = c.id;
  INSERT INTO public.connect_links (organization_id, connect_provider_ref, linked_by_code)
    VALUES (c.organization_id, p_connect_provider_ref, c.id)
    ON CONFLICT (organization_id) DO UPDATE SET connect_provider_ref = EXCLUDED.connect_provider_ref, linked_at = now(),
      linked_by_code = EXCLUDED.linked_by_code, revoked_at = NULL, revoked_by_user_id = NULL;
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
    VALUES (NULL, c.organization_id, 'CONNECT_LINKED', 'organization', c.organization_id);
  RETURN public.app_connect_org_facts(c.organization_id);
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_redeem_link_code(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_redeem_link_code(text, text) TO app_runtime;

-- Estado vigente por referencia de Connect (respaldo de la verificación). NULL si no hay vínculo vigente.
CREATE OR REPLACE FUNCTION public.app_connect_status_by_ref(p_connect_provider_ref text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.app_connect_org_facts(l.organization_id) FROM public.connect_links l
   WHERE l.connect_provider_ref = p_connect_provider_ref AND l.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.app_connect_status_by_ref(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_status_by_ref(text) TO app_runtime;

-- ---------------------------------------------------------------- aviso inmediato (bandeja de salida)
CREATE OR REPLACE FUNCTION public.app_connect_org_status_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.archived_at IS DISTINCT FROM OLD.archived_at)
     AND EXISTS (SELECT 1 FROM public.connect_links WHERE organization_id = NEW.id AND revoked_at IS NULL) THEN
    INSERT INTO public.connect_outbox (organization_id, event_type) VALUES (NEW.id, 'ORG_STATUS_CHANGED');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_org_status_trigger() FROM PUBLIC;
DROP TRIGGER IF EXISTS organizations_connect_status ON organizations;
CREATE TRIGGER organizations_connect_status AFTER UPDATE OF status, archived_at ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.app_connect_org_status_trigger();

-- El repartidor (servidor, sin persona) toma eventos pendientes con sus hechos vigentes y la referencia de Connect.
CREATE OR REPLACE FUNCTION public.app_connect_outbox_claim(p_limit integer)
RETURNS TABLE (id bigint, event_type text, facts jsonb, connect_provider_ref text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    WITH c AS (
      SELECT x.id FROM public.connect_outbox x
       WHERE x.delivered_at IS NULL AND x.next_attempt_at <= now() AND x.created_at > now() - interval '7 days'
       ORDER BY x.id LIMIT least(greatest(p_limit, 1), 100) FOR UPDATE SKIP LOCKED),
    u AS (
      UPDATE public.connect_outbox x SET attempts = x.attempts + 1, next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, x.attempts)::int))
        FROM c WHERE x.id = c.id RETURNING x.id, x.event_type, x.organization_id)
    SELECT u.id, u.event_type, public.app_connect_org_facts(u.organization_id),
           (SELECT l.connect_provider_ref FROM public.connect_links l WHERE l.organization_id = u.organization_id ORDER BY l.revoked_at NULLS FIRST LIMIT 1)
      FROM u;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_outbox_claim(integer) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_connect_outbox_report(p_id bigint, p_status integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.connect_outbox SET last_status = p_status, delivered_at = CASE WHEN p_status BETWEEN 200 AND 299 THEN now() END
   WHERE id = p_id AND delivered_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.app_connect_outbox_report(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_outbox_report(bigint, integer) TO app_runtime;

-- 182 · C-4: servicios contratados en ETNARA Connect que la FAMILIA autoriza pasar a ETNARA Care.
-- Rama integracion-connect (aprobada por Rafa el 28 nov 2026 como rama independiente). Apagada salvo
-- CONNECT_INTEGRATION=on. Preparado con IA: requiere revisión humana.
--   * Connect envía (servidor a servidor, token de servicio) SOLO lo que la familia autorizó: su nombre y correo de
--     contacto y el servicio acordado (tipo, fechas, horario, precio, política). Nunca diagnósticos ni documentos.
--   * Sin duplicados: una transferencia viva por acuerdo de Connect y organización; el mismo envío repetido es
--     idempotente. Una FAMILIA puede contratar para VARIAS personas: cada persona llega con su propia referencia
--     seudónima (connect_recipient_ref) y queda enlazada a UNA persona atendida; las siguientes transferencias de esa
--     misma persona se asocian a ella en vez de crear otra, y las otras personas de la familia se ofrecen como sugerencia.
--   * La administración (o supervisión) decide: aceptar (crear la persona atendida o usar la existente) o rechazar.
--     La decisión se avisa a Connect al instante por la bandeja firmada de la 181.
--   * La familia puede retirar su autorización mientras no se haya aceptado: se borran sus datos de contacto.

CREATE TABLE IF NOT EXISTS connect_transfers (
  id                 uuid PRIMARY KEY,                      -- el identificador de la transferencia en Connect
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connect_acuerdo_id uuid NOT NULL,
  connect_family_ref uuid NOT NULL,
  connect_recipient_ref uuid NOT NULL,                      -- la persona atendida (seudónimo por proveedor)
  payload            jsonb,                                 -- NULL tras rechazo o retiro (datos borrados)
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  care_recipient_id  uuid REFERENCES care_recipients(id) ON DELETE RESTRICT,
  decided_by         uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at         timestamptz,
  reject_reason      text CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 3 AND 300),
  received_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'accepted') = (care_recipient_id IS NOT NULL)),
  CHECK (status NOT IN ('rejected', 'withdrawn') OR payload IS NULL),
  CHECK (status = 'pending' OR status = 'withdrawn' OR decided_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connect_transfers_live ON connect_transfers (organization_id, connect_acuerdo_id)
  WHERE status IN ('pending', 'accepted');
CREATE INDEX IF NOT EXISTS idx_connect_transfers_org ON connect_transfers (organization_id, status, received_at DESC);

CREATE TABLE IF NOT EXISTS connect_recipient_links (
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  connect_recipient_ref uuid NOT NULL,
  connect_family_ref    uuid NOT NULL,
  care_recipient_id     uuid NOT NULL REFERENCES care_recipients(id) ON DELETE RESTRICT,
  linked_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, connect_recipient_ref)
);
CREATE INDEX IF NOT EXISTS idx_connect_recipient_links_family ON connect_recipient_links (organization_id, connect_family_ref);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connect_transfers', 'connect_recipient_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_definer', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (current_user <> ''app_runtime'') WITH CHECK (current_user <> ''app_runtime'')', t || '_definer', t);
  END LOOP;
END $$;

-- La bandeja de la 181 también lleva la decisión sobre una transferencia (con su identificador y resultado).
ALTER TABLE connect_outbox ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE connect_outbox DROP CONSTRAINT IF EXISTS connect_outbox_event_type_check;
ALTER TABLE connect_outbox ADD CONSTRAINT connect_outbox_event_type_check
  CHECK (event_type IN ('ORG_STATUS_CHANGED', 'LINK_REVOKED', 'TRANSFER_DECIDED'));

DROP FUNCTION IF EXISTS public.app_connect_outbox_claim(integer);
CREATE FUNCTION public.app_connect_outbox_claim(p_limit integer)
RETURNS TABLE (id bigint, event_type text, facts jsonb, connect_provider_ref text, payload jsonb)
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
        FROM c WHERE x.id = c.id RETURNING x.id, x.event_type, x.organization_id, x.payload)
    SELECT u.id, u.event_type, public.app_connect_org_facts(u.organization_id),
           (SELECT l.connect_provider_ref::text FROM public.connect_links l WHERE l.organization_id = u.organization_id ORDER BY l.revoked_at NULLS FIRST LIMIT 1),
           u.payload
      FROM u;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_outbox_claim(integer) TO app_runtime;

-- Forma del contenido autorizado (claves cerradas, tamaños acotados). Nada más entra.
CREATE OR REPLACE FUNCTION public.app_connect_transfer_payload_ok(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('familia', 'persona', 'servicio', 'municipio', 'consentimiento'))
     AND jsonb_typeof(p->'persona') = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p->'persona') k WHERE k NOT IN ('etiqueta'))
     AND char_length(coalesce(p->'persona'->>'etiqueta', '')) BETWEEN 1 AND 40
     AND jsonb_typeof(p->'familia') = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p->'familia') k WHERE k NOT IN ('nombre', 'correo'))
     AND char_length(coalesce(p->'familia'->>'nombre', '')) BETWEEN 1 AND 80
     AND char_length(coalesce(p->'familia'->>'correo', '')) BETWEEN 3 AND 254
     AND jsonb_typeof(p->'servicio') = 'object'
     AND char_length((p->'servicio')::text) <= 8000
     AND char_length(coalesce(p->>'municipio', '')) <= 60
     AND jsonb_typeof(p->'consentimiento') = 'object'
     AND char_length((p->'consentimiento')::text) <= 400;
$$;
REVOKE ALL ON FUNCTION public.app_connect_transfer_payload_ok(jsonb) FROM PUBLIC;

-- Servidor a servidor: recibir (idempotente). Devuelve 'received' | 'duplicate' | 'not_linked' | 'invalid'.
CREATE OR REPLACE FUNCTION public.app_connect_transfer_receive(p_id uuid, p_ref uuid, p_acuerdo uuid, p_family uuid, p_recipient uuid, p_payload jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid; v_prev public.connect_transfers%ROWTYPE;
BEGIN
  SELECT l.organization_id INTO v_org FROM public.connect_links l WHERE l.connect_provider_ref = p_ref::text AND l.revoked_at IS NULL;
  IF v_org IS NULL THEN RETURN 'not_linked'; END IF;
  IF p_id IS NULL OR p_acuerdo IS NULL OR p_family IS NULL OR p_recipient IS NULL OR NOT public.app_connect_transfer_payload_ok(p_payload) THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_prev FROM public.connect_transfers WHERE id = p_id;
  IF FOUND THEN RETURN CASE WHEN v_prev.organization_id = v_org THEN 'duplicate' ELSE 'invalid' END; END IF;
  IF EXISTS (SELECT 1 FROM public.connect_transfers t WHERE t.organization_id = v_org AND t.connect_acuerdo_id = p_acuerdo
               AND t.status IN ('pending', 'accepted')) THEN
    RETURN 'duplicate';
  END IF;
  INSERT INTO public.connect_transfers (id, organization_id, connect_acuerdo_id, connect_family_ref, connect_recipient_ref, payload)
  VALUES (p_id, v_org, p_acuerdo, p_family, p_recipient, p_payload);
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (NULL, v_org, 'CONNECT_TRANSFER_RECEIVED', 'connect_transfer', p_id);
  RETURN 'received';
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_transfer_receive(uuid, uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_transfer_receive(uuid, uuid, uuid, uuid, uuid, jsonb) TO app_runtime;

-- Servidor a servidor: la familia retiró su autorización. 'withdrawn' | 'already_decided' | 'unknown'.
CREATE OR REPLACE FUNCTION public.app_connect_transfer_withdraw(p_id uuid, p_ref uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid; v_t public.connect_transfers%ROWTYPE;
BEGIN
  SELECT l.organization_id INTO v_org FROM public.connect_links l WHERE l.connect_provider_ref = p_ref::text ORDER BY l.revoked_at NULLS FIRST LIMIT 1;
  SELECT * INTO v_t FROM public.connect_transfers WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF v_t.status = 'withdrawn' THEN RETURN 'withdrawn'; END IF;
  IF v_t.status <> 'pending' THEN RETURN 'already_decided'; END IF;
  UPDATE public.connect_transfers SET status = 'withdrawn', payload = NULL WHERE id = p_id;
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (NULL, v_org, 'CONNECT_TRANSFER_WITHDRAWN', 'connect_transfer', p_id);
  RETURN 'withdrawn';
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_transfer_withdraw(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_transfer_withdraw(uuid, uuid) TO app_runtime;

-- Bandeja de la organización (administración o supervisión): pendientes y decididas recientes, con la persona atendida
-- ya enlazada a esa familia (si existe) para no crear otra.
CREATE OR REPLACE FUNCTION public.app_connect_transfers_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
BEGIN
  IF NOT public.app_is_org_manager_definer() THEN RAISE EXCEPTION 'CONNECT_MANAGER_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'status', t.status, 'receivedAt', t.received_at, 'decidedAt', t.decided_at, 'payload', t.payload,
      'careRecipientId', t.care_recipient_id,
      'linkedRecipient', (SELECT jsonb_build_object('id', r.id, 'firstName', r.first_name, 'lastName', r.last_name)
                            FROM public.connect_recipient_links k JOIN public.care_recipients r ON r.id = k.care_recipient_id
                           WHERE k.organization_id = t.organization_id AND k.connect_recipient_ref = t.connect_recipient_ref),
      -- Otras personas de la MISMA familia ya atendidas: sugerencias (por si la familia nombró distinto a la misma persona).
      'familyRecipients', coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', r.id, 'firstName', r.first_name, 'lastName', r.last_name))
                            FROM public.connect_recipient_links k JOIN public.care_recipients r ON r.id = k.care_recipient_id
                           WHERE k.organization_id = t.organization_id AND k.connect_family_ref = t.connect_family_ref
                             AND k.connect_recipient_ref <> t.connect_recipient_ref AND r.status = 'active'), '[]'::jsonb))
      ORDER BY (t.status = 'pending') DESC, t.received_at DESC)
    FROM public.connect_transfers t
   WHERE t.organization_id = v_org AND (t.status = 'pending' OR t.received_at > now() - interval '90 days')), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_transfers_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_transfers_list() TO app_runtime;

-- Decidir (administración o supervisión). Aceptar exige una persona atendida ACTIVA de la organización (la API la crea
-- antes en la misma transacción, por la vía normal con RLS, o usa la existente). Si la familia ya está enlazada a otra
-- persona atendida, se exige esa (sin duplicados).
CREATE OR REPLACE FUNCTION public.app_connect_transfer_decide(p_id uuid, p_decision text, p_recipient uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
        v_t public.connect_transfers%ROWTYPE; v_linked uuid;
BEGIN
  IF NOT public.app_is_org_manager_definer() THEN RAISE EXCEPTION 'CONNECT_MANAGER_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_t FROM public.connect_transfers WHERE id = p_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONNECT_TRANSFER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_t.status <> 'pending' THEN RAISE EXCEPTION 'CONNECT_TRANSFER_NOT_PENDING' USING ERRCODE = '55000'; END IF;
  IF p_decision = 'reject' THEN
    IF p_reason IS NULL OR char_length(trim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'CONNECT_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
    UPDATE public.connect_transfers SET status = 'rejected', payload = NULL, decided_by = v_user, decided_at = now(), reject_reason = trim(p_reason) WHERE id = p_id;
  ELSIF p_decision = 'accept' THEN
    IF NOT EXISTS (SELECT 1 FROM public.care_recipients r WHERE r.id = p_recipient AND r.organization_id = v_org AND r.status = 'active') THEN
      RAISE EXCEPTION 'CONNECT_RECIPIENT_INVALID' USING ERRCODE = '22023';
    END IF;
    -- Esa PERSONA ya está enlazada: se exige su persona atendida (sin duplicados).
    SELECT k.care_recipient_id INTO v_linked FROM public.connect_recipient_links k
     WHERE k.organization_id = v_org AND k.connect_recipient_ref = v_t.connect_recipient_ref;
    IF v_linked IS NOT NULL AND v_linked <> p_recipient THEN RAISE EXCEPTION 'CONNECT_RECIPIENT_ALREADY_LINKED' USING ERRCODE = '23505'; END IF;
    IF v_linked IS NULL THEN
      INSERT INTO public.connect_recipient_links (organization_id, connect_recipient_ref, connect_family_ref, care_recipient_id)
      VALUES (v_org, v_t.connect_recipient_ref, v_t.connect_family_ref, p_recipient);
    END IF;
    UPDATE public.connect_transfers SET status = 'accepted', care_recipient_id = p_recipient, decided_by = v_user, decided_at = now() WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'CONNECT_DECISION_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.connect_outbox (organization_id, event_type, payload)
  VALUES (v_org, 'TRANSFER_DECIDED', jsonb_build_object('transferId', p_id, 'decision', CASE WHEN p_decision = 'accept' THEN 'accepted' ELSE 'rejected' END));
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (v_user, v_org, CASE WHEN p_decision = 'accept' THEN 'CONNECT_TRANSFER_ACCEPTED' ELSE 'CONNECT_TRANSFER_REJECTED' END, 'connect_transfer', p_id);
  RETURN jsonb_build_object('id', p_id, 'status', CASE WHEN p_decision = 'accept' THEN 'accepted' ELSE 'rejected' END, 'careRecipientId', CASE WHEN p_decision = 'accept' THEN p_recipient END);
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_transfer_decide(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_transfer_decide(uuid, text, uuid, text) TO app_runtime;

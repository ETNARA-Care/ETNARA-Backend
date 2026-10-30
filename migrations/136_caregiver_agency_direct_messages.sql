-- 136 · Mensajería directa agencia ↔ cuidadora (sin residente ni turno).
--
-- Reutiliza message_threads / message_thread_participants / messages con el thread_type
-- 'caregiver_agency' que 013 dejó reservado. Una conversación por agencia y cuidadora
-- (organization_worker_membership_id), nunca con residente.
--
-- Quién accede (además de ser participante y miembro activo de la agencia):
--   * ORGANIZATION_ADMIN de esa agencia, o
--   * la cuidadora de esa membresía, mientras la membresía siga activa.
-- Se aplica en el código (roleGuards.threadAccessSql) y en RLS con políticas RESTRICTIVE nuevas:
-- no se toca ninguna política existente (038/132 las redefinen y se combinan con estas).
--
-- Solo crea columna, restricción, índice, funciones y políticas. No cambia filas existentes.
-- Reversión: ops/136_caregiver_agency_direct_messages.rollback.sql (conserva conversaciones y mensajes).

ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS organization_worker_membership_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_worker_membership_fkey') THEN
    ALTER TABLE message_threads
      ADD CONSTRAINT message_threads_worker_membership_fkey
      FOREIGN KEY (organization_worker_membership_id, organization_id)
      REFERENCES organization_worker_memberships (id, organization_id);
  END IF;
  -- NOT VALID: solo se comprueba en filas nuevas o modificadas; las existentes no se revisan
  -- (la migración no puede fallar por datos antiguos).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_caregiver_agency_shape') THEN
    ALTER TABLE message_threads
      ADD CONSTRAINT message_threads_caregiver_agency_shape CHECK (
        (thread_type = 'caregiver_agency')
          = (organization_worker_membership_id IS NOT NULL AND care_recipient_id IS NULL)
      ) NOT VALID;
  END IF;
END $$;

-- Sin duplicados: una conversación directa por agencia y cuidadora.
CREATE UNIQUE INDEX IF NOT EXISTS message_threads_caregiver_agency_unique
  ON message_threads (organization_id, organization_worker_membership_id)
  WHERE thread_type = 'caregiver_agency';

-- ¿Puede p_user usar la conversación directa p_thread? (false si no es directa)
CREATE OR REPLACE FUNCTION public.app_user_can_access_caregiver_thread(p_user uuid, p_thread uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.message_threads t
    JOIN public.message_thread_participants p
      ON p.message_thread_id = t.id AND p.organization_id = t.organization_id AND p.user_id = p_user
    JOIN public.organization_memberships om
      ON om.user_id = p_user AND om.organization_id = t.organization_id AND om.status = 'active'
    JOIN public.users u ON u.id = p_user AND u.status = 'active'
    WHERE t.id = p_thread
      AND t.thread_type = 'caregiver_agency'
      AND (
        EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
                 WHERE ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                   AND r.code = 'ORGANIZATION_ADMIN')
        OR EXISTS (SELECT 1 FROM public.organization_worker_memberships owm
                    JOIN public.workers w ON w.id = owm.worker_id
                   WHERE owm.id = t.organization_worker_membership_id
                     AND owm.organization_id = t.organization_id
                     AND owm.status = 'active'
                     AND w.user_id = p_user)
      )
  );
$$;

-- ¿Es una conversación directa? (ve el tipo aunque RLS oculte la fila a quien pregunta)
CREATE OR REPLACE FUNCTION public.app_is_caregiver_thread(p_thread uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = p_thread AND t.thread_type = 'caregiver_agency');
$$;

-- Regla combinada para las políticas: las conversaciones que no son directas no cambian.
CREATE OR REPLACE FUNCTION public.app_thread_direct_guard(p_thread uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_caregiver_thread(p_thread)
      OR public.app_user_can_access_caregiver_thread(NULLIF(current_setting('app.current_user_id', true), '')::uuid, p_thread);
$$;

-- Abre (o devuelve) la conversación directa con la cuidadora de p_worker_membership en la agencia
-- activa. Solo ORGANIZATION_ADMIN. Participantes: la cuidadora y las administradoras activas.
-- Idempotente y sin duplicados (candado + índice único). Audita solo la creación.
CREATE OR REPLACE FUNCTION public.app_open_caregiver_thread(p_worker_membership uuid)
RETURNS TABLE (thread_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_worker_user uuid;
  v_thread uuid;
  v_created boolean := false;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'CAREGIVER_THREAD_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN roles r ON r.id = ur.role_id
    WHERE om.user_id = v_user AND om.organization_id = v_org AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
  ) THEN
    RAISE EXCEPTION 'CAREGIVER_THREAD_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT w.user_id INTO v_worker_user
  FROM organization_worker_memberships owm JOIN workers w ON w.id = owm.worker_id
  WHERE owm.id = p_worker_membership AND owm.organization_id = v_org AND owm.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'CAREGIVER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_worker_user IS NULL
     OR NOT EXISTS (SELECT 1 FROM organization_memberships om JOIN users u ON u.id = om.user_id
                     WHERE om.user_id = v_worker_user AND om.organization_id = v_org AND om.status = 'active' AND u.status = 'active') THEN
    RAISE EXCEPTION 'CAREGIVER_NO_ACCOUNT' USING ERRCODE = '22023';
  END IF;
  IF v_worker_user = v_user THEN RAISE EXCEPTION 'CAREGIVER_THREAD_SELF' USING ERRCODE = '22023'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('caregiver-thread:' || v_org::text || ':' || p_worker_membership::text, 0));
  SELECT t.id INTO v_thread FROM message_threads t
  WHERE t.organization_id = v_org AND t.thread_type = 'caregiver_agency' AND t.organization_worker_membership_id = p_worker_membership;
  IF v_thread IS NULL THEN
    INSERT INTO message_threads (organization_id, care_recipient_id, thread_type, organization_worker_membership_id)
    VALUES (v_org, NULL, 'caregiver_agency', p_worker_membership)
    RETURNING id INTO v_thread;
    v_created := true;
    INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
    VALUES (v_user, v_org, v_org, 'CAREGIVER_CONVERSATION_OPENED', 'message_thread', v_thread,
            jsonb_build_object('organization_worker_membership_id', p_worker_membership));
  END IF;

  -- Participantes: la cuidadora, quien abre y las administradoras activas (sin duplicar).
  INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
  SELECT v_org, v_thread, x.user_id, true
  FROM (
    SELECT v_worker_user AS user_id
    UNION SELECT v_user
    UNION SELECT om.user_id FROM organization_memberships om
          JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
          JOIN roles r ON r.id = ur.role_id
          WHERE om.organization_id = v_org AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
  ) x
  ON CONFLICT (message_thread_id, user_id) DO NOTHING;

  RETURN QUERY SELECT v_thread, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.app_user_can_access_caregiver_thread(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_is_caregiver_thread(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_thread_direct_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_open_caregiver_thread(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_user_can_access_caregiver_thread(uuid, uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_is_caregiver_thread(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_thread_direct_guard(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_open_caregiver_thread(uuid) TO app_runtime;

-- RLS (app_runtime): políticas RESTRICTIVE nuevas; se suman a las existentes sin reemplazarlas.
DROP POLICY IF EXISTS message_threads_caregiver_agency_guard ON message_threads;
CREATE POLICY message_threads_caregiver_agency_guard ON message_threads
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (thread_type <> 'caregiver_agency' OR public.app_user_can_access_caregiver_thread(NULLIF(current_setting('app.current_user_id', true), '')::uuid, id))
  -- Solo app_open_caregiver_thread (SECURITY DEFINER) crea conversaciones directas.
  WITH CHECK (thread_type <> 'caregiver_agency');

DROP POLICY IF EXISTS messages_caregiver_agency_guard ON messages;
CREATE POLICY messages_caregiver_agency_guard ON messages
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (public.app_thread_direct_guard(message_thread_id))
  WITH CHECK (public.app_thread_direct_guard(message_thread_id));

DROP POLICY IF EXISTS message_thread_participants_caregiver_agency_guard ON message_thread_participants;
CREATE POLICY message_thread_participants_caregiver_agency_guard ON message_thread_participants
  AS RESTRICTIVE FOR INSERT TO app_runtime
  -- Nadie añade participantes a una conversación directa salvo app_open_caregiver_thread.
  WITH CHECK (NOT public.app_is_caregiver_thread(message_thread_id));

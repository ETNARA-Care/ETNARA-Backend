-- 151: «Escribir a mi agencia» (D4, 5-nov-2026). Amplía la mensajería directa de 136.
--
-- 1. La cuidadora puede abrir ella misma su conversación directa con su agencia
--    (app_open_my_agency_thread). Sigue habiendo UNA conversación por agencia y cuidadora (mismo
--    índice único y candado de 136): si la abrió antes la administración, es la misma.
-- 2. Quién atiende la conversación interna ("handlers"):
--      * todas las ORGANIZATION_ADMIN activas de la agencia (sin autorización individual);
--      * las SUPERVISOR activas que una administradora autorice expresamente
--        (caregiver_message_handlers; la autorización se revoca y ambas cosas quedan auditadas).
--    Perder el rol, la membresía, la cuenta activa o la autorización quita el acceso al instante:
--    el acceso se comprueba en cada lectura/escritura (las filas de participantes se conservan
--    como historial).
-- 3. Las conversaciones con familias no cambian (las guardas solo aplican a 'caregiver_agency').
-- 4. ETNARA Central no tiene acceso (platform_phi_deny en la tabla nueva).
--
-- No cambia filas existentes (ni conversaciones, ni mensajes, ni participantes). No toca 149.
-- Redefine dos funciones de 136 con la MISMA firma. Idempotente.
-- Reversión: ops/151_caregiver_initiated_agency_messages.rollback.sql (restaura 136 literalmente).

-- ---------------------------------------------------------------- autorizaciones de supervisoras
CREATE TABLE IF NOT EXISTS caregiver_message_handlers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  organization_membership_id uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  CONSTRAINT caregiver_message_handlers_revocation_shape CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
-- Una autorización vigente por persona y agencia; las revocadas quedan como historial.
CREATE UNIQUE INDEX IF NOT EXISTS caregiver_message_handlers_active_unique
  ON caregiver_message_handlers (organization_id, organization_membership_id) WHERE revoked_at IS NULL;

ALTER TABLE caregiver_message_handlers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS caregiver_message_handlers_read ON caregiver_message_handlers;
CREATE POLICY caregiver_message_handlers_read ON caregiver_message_handlers FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());
DROP POLICY IF EXISTS platform_phi_deny ON caregiver_message_handlers;
CREATE POLICY platform_phi_deny ON caregiver_message_handlers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
-- La aplicación solo LEE la tabla; altas y revocaciones pasan por las funciones de abajo.
REVOKE ALL ON caregiver_message_handlers FROM PUBLIC;
GRANT SELECT ON caregiver_message_handlers TO app_runtime;

-- Personas que atienden las conversaciones internas de p_org ahora mismo.
CREATE OR REPLACE FUNCTION public.app_caregiver_thread_handler_users(p_org uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT om.user_id
  FROM public.organization_memberships om
  JOIN public.users u ON u.id = om.user_id AND u.status = 'active'
  JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
  JOIN public.roles r ON r.id = ur.role_id
  WHERE om.organization_id = p_org AND om.status = 'active'
    AND (r.code = 'ORGANIZATION_ADMIN'
         OR (r.code = 'SUPERVISOR' AND EXISTS (
               SELECT 1 FROM public.caregiver_message_handlers h
               WHERE h.organization_id = om.organization_id AND h.organization_membership_id = om.id
                 AND h.revoked_at IS NULL)));
$$;

-- ---------------------------------------------------------------- acceso (misma firma que 136)
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
        -- 151: administradoras activas y supervisoras autorizadas (y vigentes).
        p_user IN (SELECT public.app_caregiver_thread_handler_users(t.organization_id))
        OR EXISTS (SELECT 1 FROM public.organization_worker_memberships owm
                    JOIN public.workers w ON w.id = owm.worker_id
                   WHERE owm.id = t.organization_worker_membership_id
                     AND owm.organization_id = t.organization_id
                     AND owm.status = 'active'
                     AND w.user_id = p_user)
      )
  );
$$;

-- Añade a quien atiende como participante de las conversaciones internas existentes de su agencia.
CREATE OR REPLACE FUNCTION public.app_add_caregiver_thread_handlers(p_org uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.message_thread_participants (organization_id, message_thread_id, user_id, can_write)
  SELECT t.organization_id, t.id, h, true
  FROM public.message_threads t, public.app_caregiver_thread_handler_users(p_org) h
  WHERE t.organization_id = p_org AND t.thread_type = 'caregiver_agency'
  ON CONFLICT (message_thread_id, user_id) DO NOTHING;
$$;

-- Una administradora nueva (rol asignado después) entra sin pasos adicionales.
CREATE OR REPLACE FUNCTION public.app_caregiver_thread_handlers_on_role()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.roles r WHERE r.id = NEW.role_id AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')) THEN
    PERFORM public.app_add_caregiver_thread_handlers(NEW.organization_id);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS user_roles_caregiver_thread_handlers ON user_roles;
CREATE TRIGGER user_roles_caregiver_thread_handlers
  AFTER INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION public.app_caregiver_thread_handlers_on_role();

-- ---------------------------------------------------------------- autorizar / revocar supervisoras
CREATE OR REPLACE FUNCTION public.app_set_caregiver_message_handler(p_membership uuid, p_active boolean)
RETURNS TABLE (changed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_target_user uuid;
  v_changed boolean := false;
BEGIN
  IF v_user IS NULL OR v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_memberships om
    JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = om.user_id AND u.status = 'active'
    WHERE om.user_id = v_user AND om.organization_id = v_org AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
  ) THEN
    RAISE EXCEPTION 'MESSAGE_HANDLER_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Solo una supervisora activa de la MISMA agencia (las administradoras ya atienden siempre).
  SELECT om.user_id INTO v_target_user
  FROM organization_memberships om
  JOIN user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
  JOIN roles r ON r.id = ur.role_id AND r.code = 'SUPERVISOR'
  WHERE om.id = p_membership AND om.organization_id = v_org AND om.status = 'active'
  LIMIT 1;
  IF v_target_user IS NULL AND p_active THEN RAISE EXCEPTION 'MESSAGE_HANDLER_NOT_SUPERVISOR' USING ERRCODE = 'P0002'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('message-handler:' || v_org::text || ':' || p_membership::text, 0));
  IF p_active THEN
    IF NOT EXISTS (SELECT 1 FROM caregiver_message_handlers WHERE organization_id = v_org AND organization_membership_id = p_membership AND revoked_at IS NULL) THEN
      INSERT INTO caregiver_message_handlers (organization_id, organization_membership_id, granted_by_user_id) VALUES (v_org, p_membership, v_user);
      INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
      VALUES (v_user, v_org, v_org, 'CAREGIVER_MESSAGE_HANDLER_GRANTED', 'organization_membership', p_membership, jsonb_build_object('role', 'SUPERVISOR'));
      PERFORM public.app_add_caregiver_thread_handlers(v_org);
      v_changed := true;
    END IF;
  ELSE
    UPDATE caregiver_message_handlers SET revoked_at = now(), revoked_by_user_id = v_user
    WHERE organization_id = v_org AND organization_membership_id = p_membership AND revoked_at IS NULL;
    IF FOUND THEN
      INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value)
      VALUES (v_user, v_org, v_org, 'CAREGIVER_MESSAGE_HANDLER_REVOKED', 'organization_membership', p_membership, jsonb_build_object('role', 'SUPERVISOR'));
      v_changed := true;
    END IF;
  END IF;
  RETURN QUERY SELECT v_changed;
END;
$$;

-- Perder el rol de supervisora o la membresía activa revoca la autorización (auditado), para que
-- nunca se restaure sola si más adelante la persona recupera el rol. El acceso ya se pierde al
-- instante por app_caregiver_thread_handler_users; esto deja además el registro coherente.
CREATE OR REPLACE FUNCTION public.app_revoke_caregiver_message_handler_on_loss()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_membership uuid;
  v_org uuid;
  v_reason text;
  r record;
BEGIN
  IF TG_TABLE_NAME = 'user_roles' THEN
    IF NOT EXISTS (SELECT 1 FROM public.roles x WHERE x.id = OLD.role_id AND x.code = 'SUPERVISOR') THEN RETURN NULL; END IF;
    v_membership := OLD.organization_membership_id; v_org := OLD.organization_id; v_reason := 'role_removed';
  ELSE
    IF NEW.status = 'active' OR OLD.status IS DISTINCT FROM 'active' THEN RETURN NULL; END IF;
    v_membership := NEW.id; v_org := NEW.organization_id; v_reason := 'membership_inactive';
  END IF;
  FOR r IN UPDATE public.caregiver_message_handlers h
             SET revoked_at = now(), revoked_by_user_id = COALESCE(v_actor, h.granted_by_user_id)
           WHERE h.organization_id = v_org AND h.organization_membership_id = v_membership AND h.revoked_at IS NULL
           RETURNING h.revoked_by_user_id
  LOOP
    INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
    VALUES (r.revoked_by_user_id, v_org, v_org, 'CAREGIVER_MESSAGE_HANDLER_REVOKED', 'organization_membership', v_membership,
            jsonb_build_object('role', 'SUPERVISOR'), jsonb_build_object('reason', v_reason));
  END LOOP;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS user_roles_revoke_message_handler ON user_roles;
CREATE TRIGGER user_roles_revoke_message_handler
  AFTER DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION public.app_revoke_caregiver_message_handler_on_loss();
DROP TRIGGER IF EXISTS organization_memberships_revoke_message_handler ON organization_memberships;
CREATE TRIGGER organization_memberships_revoke_message_handler
  AFTER UPDATE OF status ON organization_memberships FOR EACH ROW EXECUTE FUNCTION public.app_revoke_caregiver_message_handler_on_loss();

-- ---------------------------------------------------------------- abrir desde la agencia (misma firma que 136)
-- Ahora también la puede abrir una supervisora autorizada. Participantes: la cuidadora y quienes atienden.
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
  IF v_user IS NULL OR v_org IS NULL OR v_user NOT IN (SELECT public.app_caregiver_thread_handler_users(v_org)) THEN
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
            jsonb_build_object('organization_worker_membership_id', p_worker_membership, 'initiated_by', 'agency'));
  END IF;

  INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
  SELECT v_org, v_thread, x.user_id, true
  FROM (SELECT v_worker_user AS user_id UNION SELECT h FROM public.app_caregiver_thread_handler_users(v_org) h) x
  ON CONFLICT (message_thread_id, user_id) DO NOTHING;

  RETURN QUERY SELECT v_thread, v_created;
END;
$$;

-- ---------------------------------------------------------------- «Escribir a mi agencia»
-- Solo la propia cuidadora (membresía de cuidadora activa en la agencia activa, cuenta activa).
CREATE OR REPLACE FUNCTION public.app_open_my_agency_thread()
RETURNS TABLE (thread_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_owm uuid;
  v_thread uuid;
  v_created boolean := false;
BEGIN
  IF v_user IS NULL OR v_org IS NULL THEN RAISE EXCEPTION 'CAREGIVER_THREAD_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT owm.id INTO v_owm
  FROM organization_worker_memberships owm
  JOIN workers w ON w.id = owm.worker_id AND w.user_id = v_user
  WHERE owm.organization_id = v_org AND owm.status = 'active'
  ORDER BY owm.created_at LIMIT 1;
  IF v_owm IS NULL OR NOT EXISTS (
       SELECT 1 FROM organization_memberships om JOIN users u ON u.id = om.user_id AND u.status = 'active'
       WHERE om.user_id = v_user AND om.organization_id = v_org AND om.status = 'active') THEN
    RAISE EXCEPTION 'CAREGIVER_THREAD_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_caregiver_thread_handler_users(v_org) h WHERE h <> v_user) THEN
    RAISE EXCEPTION 'AGENCY_HAS_NO_MESSAGE_HANDLER' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('caregiver-thread:' || v_org::text || ':' || v_owm::text, 0));
  SELECT t.id INTO v_thread FROM message_threads t
  WHERE t.organization_id = v_org AND t.thread_type = 'caregiver_agency' AND t.organization_worker_membership_id = v_owm;
  IF v_thread IS NULL THEN
    INSERT INTO message_threads (organization_id, care_recipient_id, thread_type, organization_worker_membership_id)
    VALUES (v_org, NULL, 'caregiver_agency', v_owm)
    RETURNING id INTO v_thread;
    v_created := true;
    INSERT INTO audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, new_value)
    VALUES (v_user, v_org, v_org, 'CAREGIVER_CONVERSATION_OPENED', 'message_thread', v_thread,
            jsonb_build_object('organization_worker_membership_id', v_owm, 'initiated_by', 'caregiver'));
  END IF;

  INSERT INTO message_thread_participants (organization_id, message_thread_id, user_id, can_write)
  SELECT v_org, v_thread, x.user_id, true
  FROM (SELECT v_user AS user_id UNION SELECT h FROM public.app_caregiver_thread_handler_users(v_org) h) x
  ON CONFLICT (message_thread_id, user_id) DO NOTHING;

  RETURN QUERY SELECT v_thread, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.app_caregiver_thread_handler_users(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_add_caregiver_thread_handlers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_caregiver_thread_handlers_on_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_revoke_caregiver_message_handler_on_loss() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_set_caregiver_message_handler(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_open_my_agency_thread() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_set_caregiver_message_handler(uuid, boolean) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_open_my_agency_thread() TO app_runtime;
-- (app_user_can_access_caregiver_thread y app_open_caregiver_thread conservan el EXECUTE de 136.)

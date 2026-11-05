-- Reversión de 151 (deja el esquema igual que 150). Ejecutar como propietario de las migraciones,
-- DESPUÉS de volver a desplegar el backend anterior (el código de 151 llama a las funciones nuevas).
-- No destructiva para mensajes: conversaciones, mensajes y participantes se CONSERVAN. Se pierde la
-- tabla de autorizaciones de supervisoras (sus altas y bajas siguen en audit_log). Las dos funciones
-- de 136 vuelven a su texto original (copiado literalmente de 136): solo administradoras y la
-- cuidadora; una conversación abierta por la cuidadora sigue existiendo y funcionando igual.
BEGIN;
DROP TRIGGER IF EXISTS user_roles_caregiver_thread_handlers ON user_roles;
DROP FUNCTION IF EXISTS public.app_caregiver_thread_handlers_on_role();
DROP TRIGGER IF EXISTS user_roles_revoke_message_handler ON user_roles;
DROP TRIGGER IF EXISTS organization_memberships_revoke_message_handler ON organization_memberships;
DROP FUNCTION IF EXISTS public.app_revoke_caregiver_message_handler_on_loss();
DROP FUNCTION IF EXISTS public.app_open_my_agency_thread();
DROP FUNCTION IF EXISTS public.app_set_caregiver_message_handler(uuid, boolean);

-- 136, literal:
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

-- 136, literal:
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

DROP FUNCTION IF EXISTS public.app_add_caregiver_thread_handlers(uuid);
DROP FUNCTION IF EXISTS public.app_caregiver_thread_handler_users(uuid);
DROP TABLE IF EXISTS caregiver_message_handlers;
DELETE FROM schema_migrations WHERE filename = '151_caregiver_initiated_agency_messages.sql';
COMMIT;

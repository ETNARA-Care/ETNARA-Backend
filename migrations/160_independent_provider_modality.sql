-- 160 · Cuidador independiente como tercera modalidad (PR A: ETNARA Central y activación). 23-nov-2026.
--
-- Decisiones de Rafa (23-nov-2026):
--   * Una sola persona con los roles ORGANIZATION_ADMIN y WORKER, una sola cuenta y un solo correo.
--   * ETNARA Care no verifica ni aprueba credenciales de independientes (eso llega en el PR C).
--   * La modalidad permanece APAGADA en la plataforma hasta completar y validar los PR A, B y C.
--   * El tipo de organización no se modifica después sin un procedimiento específico.
--   * Las agencias y los hogares no cambian: cada regla nueva se activa SOLO si la organización es
--     INDEPENDENT_PROVIDER (valor que ya existe en organization_type_enum desde 002).
--
-- Contenido:
--   1. platform_modalities + app_platform_modality_enabled(): interruptor de plataforma, apagado. app_runtime
--      no puede escribirlo; encenderlo es un paso de operación explícito y autorizado.
--   2. organizations: no se crea una organización INDEPENDENT_PROVIDER con la modalidad apagada, y el tipo es
--      inmutable salvo mediante app_ops_change_organization_type() (solo propietario de las migraciones,
--      nunca app_runtime; auditado; nunca hacia ni desde INDEPENDENT_PROVIDER).
--   3. Una sola persona operativa en INDEPENDENT_PROVIDER (base de datos, no solo el portal):
--      user_roles, organization_worker_memberships y access_invitations.
--   4. app_activate_organization_admin_invitation: idéntica a la 085 salvo que, en INDEPENDENT_PROVIDER,
--      la misma transacción añade WORKER, el perfil único de la persona (lo reutiliza si ya existe, como la 159)
--      y su membresía de cuidadora, con auditoría INDEPENDENT_OPERATOR_PROVISIONED.
-- Reversión: ops/160_independent_provider_modality.rollback.sql.

-- 1. Interruptor de plataforma ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_modalities (
    code        text PRIMARY KEY CHECK (code IN ('INDEPENDENT_PROVIDER')),
    enabled     boolean NOT NULL DEFAULT false,
    note        text NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_modalities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_modalities FROM PUBLIC;
REVOKE ALL ON platform_modalities FROM app_runtime;
INSERT INTO platform_modalities (code, enabled, note)
VALUES ('INDEPENDENT_PROVIDER', false, '160: apagada hasta completar y validar los PR A, B y C (decisión de Rafa, 23-nov-2026).')
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION app_platform_modality_enabled(p_code text)
RETURNS boolean AS $$
  SELECT COALESCE((SELECT pm.enabled FROM public.platform_modalities pm WHERE pm.code = p_code), false);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_platform_modality_enabled(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_modality_enabled(text) TO app_runtime;

-- ¿La organización es de un cuidador independiente? (lo usan los guardas de abajo)
CREATE OR REPLACE FUNCTION app_org_is_independent(p_organization_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id AND o.organization_type = 'INDEPENDENT_PROVIDER');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_org_is_independent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_org_is_independent(uuid) TO app_runtime;

-- 2. Creación y tipo inmutable ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_organization_type_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_type = 'INDEPENDENT_PROVIDER' AND NOT public.app_platform_modality_enabled('INDEPENDENT_PROVIDER') THEN
      RAISE EXCEPTION 'INDEPENDENT_MODALITY_DISABLED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_type IS DISTINCT FROM OLD.organization_type THEN
    -- Solo el procedimiento de operación (app_ops_change_organization_type) y nunca la aplicación.
    IF session_user = 'app_runtime' OR COALESCE(current_setting('etnara.organization_type_change', true), '') <> 'ops-procedure' THEN
      RAISE EXCEPTION 'ORGANIZATION_TYPE_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS organizations_type_guard ON organizations;
CREATE TRIGGER organizations_type_guard
  BEFORE INSERT OR UPDATE OF organization_type ON organizations
  FOR EACH ROW EXECUTE FUNCTION app_organization_type_guard();

-- Procedimiento específico para corregir un tipo (p. ej. agencia creada como hogar por error).
-- Solo el propietario de las migraciones lo ejecuta (sin GRANT a app_runtime). Nunca convierte hacia ni desde
-- INDEPENDENT_PROVIDER: en ese caso se crea otra organización. Queda auditado.
CREATE OR REPLACE FUNCTION app_ops_change_organization_type(p_organization_id uuid, p_new_type organization_type_enum, p_reason text, p_requested_by text)
RETURNS void AS $$
DECLARE
  v_old organization_type_enum;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR p_requested_by IS NULL OR length(btrim(p_requested_by)) < 3 THEN
    RAISE EXCEPTION 'ORGANIZATION_TYPE_CHANGE_REASON_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.organization_type INTO v_old FROM public.organizations o WHERE o.id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_old = p_new_type THEN RETURN; END IF;
  IF v_old = 'INDEPENDENT_PROVIDER' OR p_new_type = 'INDEPENDENT_PROVIDER' THEN
    RAISE EXCEPTION 'ORGANIZATION_TYPE_CHANGE_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('etnara.organization_type_change', 'ops-procedure', true);
  UPDATE public.organizations SET organization_type = p_new_type, updated_at = now() WHERE id = p_organization_id;
  PERFORM set_config('etnara.organization_type_change', '', true);
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (NULL, p_organization_id, p_organization_id, 'ORGANIZATION_TYPE_CHANGED_BY_PROCEDURE', 'organization', p_organization_id,
          jsonb_build_object('organizationType', v_old),
          jsonb_build_object('organizationType', p_new_type, 'reason', btrim(p_reason), 'requestedBy', btrim(p_requested_by)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_ops_change_organization_type(uuid, organization_type_enum, text, text) FROM PUBLIC;

-- 3. Una sola persona operativa en INDEPENDENT_PROVIDER ----------------------------------------------------
-- 3a. Roles: sin SUPERVISOR; ORGANIZATION_ADMIN de una sola persona; WORKER solo para esa persona;
--     FAMILY nunca se combina con ADMIN/WORKER.
CREATE OR REPLACE FUNCTION app_independent_roles_guard()
RETURNS trigger AS $$
DECLARE
  v_code text;
  v_user uuid;
BEGIN
  IF NOT public.app_org_is_independent(NEW.organization_id) THEN RETURN NEW; END IF;
  SELECT r.code INTO v_code FROM public.roles r WHERE r.id = NEW.role_id;
  SELECT om.user_id INTO v_user FROM public.organization_memberships om WHERE om.id = NEW.organization_membership_id;
  IF v_code NOT IN ('ORGANIZATION_ADMIN', 'WORKER', 'FAMILY') THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF v_code = 'ORGANIZATION_ADMIN' AND EXISTS (
      SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      JOIN public.organization_memberships om ON om.id = ur.organization_membership_id
      WHERE ur.organization_id = NEW.organization_id AND r.code = 'ORGANIZATION_ADMIN' AND om.user_id <> v_user) THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF v_code = 'WORKER' AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.organization_membership_id = NEW.organization_membership_id AND r.code = 'ORGANIZATION_ADMIN') THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF v_code = 'FAMILY' AND EXISTS (
      SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.organization_membership_id = NEW.organization_membership_id AND r.code IN ('ORGANIZATION_ADMIN', 'WORKER')) THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF v_code IN ('ORGANIZATION_ADMIN', 'WORKER') AND EXISTS (
      SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.organization_membership_id = NEW.organization_membership_id AND r.code = 'FAMILY') THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS user_roles_independent_guard ON user_roles;
CREATE TRIGGER user_roles_independent_guard
  BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION app_independent_roles_guard();

-- 3b. Fichas de cuidador: una sola, y siempre de la persona administradora (nada de fichas provisionales).
CREATE OR REPLACE FUNCTION app_independent_worker_membership_guard()
RETURNS trigger AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NOT public.app_org_is_independent(NEW.organization_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.organization_worker_memberships m WHERE m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    SELECT w.user_id INTO v_user FROM public.workers w WHERE w.id = NEW.worker_id;
    IF v_user IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE om.organization_id = NEW.organization_id AND om.user_id = v_user AND r.code = 'ORGANIZATION_ADMIN') THEN
      RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS organization_worker_memberships_independent_guard ON organization_worker_memberships;
CREATE TRIGGER organization_worker_memberships_independent_guard
  BEFORE INSERT OR UPDATE OF worker_id, organization_id ON organization_worker_memberships
  FOR EACH ROW EXECUTE FUNCTION app_independent_worker_membership_guard();

-- 3c. Invitaciones: sin invitaciones de cuidador ni de supervisora; una sola administradora. Familia, sí.
CREATE OR REPLACE FUNCTION app_independent_invitation_guard()
RETURNS trigger AS $$
BEGIN
  IF NOT public.app_org_is_independent(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.invitation_type = 'worker' THEN
    RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invitation_type = 'organization_admin' THEN
    IF COALESCE(NEW.staff_role, '') <> 'ORGANIZATION_ADMIN' THEN
      RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE om.organization_id = NEW.organization_id AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN'
          AND lower(COALESCE((SELECT u.email FROM public.users u WHERE u.id = om.user_id), '')) <> lower(NEW.email)) THEN
      RAISE EXCEPTION 'INDEPENDENT_SINGLE_OPERATOR' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS access_invitations_independent_guard ON access_invitations;
CREATE TRIGGER access_invitations_independent_guard
  BEFORE INSERT ON access_invitations
  FOR EACH ROW EXECUTE FUNCTION app_independent_invitation_guard();

-- 4. Activación de la administradora: en INDEPENDENT_PROVIDER también queda como cuidadora -----------------
-- Perfil único por persona (workers.user_id UNIQUE, misma regla que la 159): si ya tiene perfil (p. ej. trabaja
-- en una agencia) se reutiliza tal cual; sus credenciales y sus agencias no cambian.
CREATE OR REPLACE FUNCTION app_independent_provision_operator(p_user_id uuid, p_organization_id uuid, p_org_membership_id uuid, p_invitation_id uuid)
RETURNS void AS $$
DECLARE
  v_worker uuid;
  v_created boolean := false;
  v_membership uuid;
  v_role uuid;
BEGIN
  SELECT w.id INTO v_worker FROM public.workers w WHERE w.user_id = p_user_id FOR UPDATE;
  IF v_worker IS NULL THEN
    INSERT INTO public.workers (user_id) VALUES (p_user_id) RETURNING id INTO v_worker;
    v_created := true;
  END IF;

  SELECT r.id INTO v_role FROM public.roles r WHERE r.code = 'WORKER' LIMIT 1;
  IF v_role IS NULL THEN RAISE EXCEPTION 'ROLE_NOT_CONFIGURED' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.user_roles (organization_membership_id, organization_id, role_id)
  VALUES (p_org_membership_id, p_organization_id, v_role)
  ON CONFLICT (organization_membership_id, role_id) DO NOTHING;

  SELECT m.id INTO v_membership FROM public.organization_worker_memberships m
  WHERE m.organization_id = p_organization_id AND m.worker_id = v_worker FOR UPDATE;
  IF v_membership IS NULL THEN
    INSERT INTO public.organization_worker_memberships (worker_id, organization_id, status, internal_role, hired_at)
    VALUES (v_worker, p_organization_id, 'active', 'INDEPENDENT_CAREGIVER', now())
    RETURNING id INTO v_membership;
  ELSE
    UPDATE public.organization_worker_memberships SET status = 'active', ended_at = NULL, updated_at = now() WHERE id = v_membership;
  END IF;

  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id, previous_value, new_value)
  VALUES (p_user_id, p_organization_id, p_organization_id, 'INDEPENDENT_OPERATOR_PROVISIONED', 'organization_worker_membership', v_membership,
          NULL, jsonb_build_object('workerId', v_worker, 'profileCreated', v_created, 'invitationId', p_invitation_id, 'roles', jsonb_build_array('ORGANIZATION_ADMIN', 'WORKER')));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_independent_provision_operator(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- Cuerpo de la 085 sin cambios salvo el bloque marcado «160».
CREATE OR REPLACE FUNCTION app_activate_organization_admin_invitation(
  p_token_hash text,
  p_password_hash text DEFAULT NULL,
  p_existing_user_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, organization_id uuid, invitation_type text) AS $$
DECLARE
  v_inv public.access_invitations%ROWTYPE;
  v_existing public.users%ROWTYPE;
  v_user uuid;
  v_membership uuid;
  v_role uuid;
BEGIN
  SELECT * INTO v_inv
  FROM public.access_invitations AS target_invitation
  WHERE target_invitation.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND OR v_inv.invitation_type <> 'organization_admin' OR v_inv.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVITATION_NOT_AVAILABLE';
  END IF;

  IF v_inv.expires_at <= now() THEN
    UPDATE public.access_invitations AS target_invitation
    SET status='expired', updated_at=now()
    WHERE target_invitation.id = v_inv.id;
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVITATION_EXPIRED';
  END IF;

  PERFORM 1 FROM public.organizations AS target_org
  WHERE target_org.id = v_inv.organization_id
    AND target_org.status IN ('active', 'trial')
    AND target_org.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVITATION_NOT_AVAILABLE';
  END IF;

  IF v_inv.staff_role IS NULL OR v_inv.staff_role NOT IN ('ORGANIZATION_ADMIN', 'SUPERVISOR') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVITATION_NOT_AVAILABLE';
  END IF;

  SELECT * INTO v_existing
  FROM public.users AS existing_user
  WHERE lower(existing_user.email) = lower(v_inv.email)
  LIMIT 1;

  IF FOUND THEN
    IF p_existing_user_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ACCOUNT_ALREADY_EXISTS';
    END IF;
    IF v_existing.id <> p_existing_user_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVITATION_IDENTITY_MISMATCH';
    END IF;
    IF v_existing.status <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ACCOUNT_DISABLED';
    END IF;
    v_user := v_existing.id;
  ELSE
    IF p_existing_user_id IS NOT NULL OR p_password_hash IS NULL OR length(p_password_hash) < 20 THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INVALID_ACTIVATION';
    END IF;
    INSERT INTO public.users(email, password_hash, status)
    VALUES(lower(v_inv.email), p_password_hash, 'active')
    RETURNING users.id INTO v_user;
  END IF;

  INSERT INTO public.organization_memberships(user_id, organization_id, status, revoked_at, updated_at)
  VALUES(v_user, v_inv.organization_id, 'active', NULL, now())
  ON CONFLICT ON CONSTRAINT organization_memberships_user_id_organization_id_key DO UPDATE
    SET status='active', revoked_at=NULL, updated_at=now()
  RETURNING organization_memberships.id INTO v_membership;

  SELECT role_record.id INTO v_role
  FROM public.roles AS role_record
  WHERE role_record.code = v_inv.staff_role
  LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROLE_NOT_CONFIGURED';
  END IF;

  INSERT INTO public.user_roles(organization_membership_id, organization_id, role_id)
  VALUES(v_membership, v_inv.organization_id, v_role)
  ON CONFLICT(organization_membership_id, role_id) DO NOTHING;

  -- 160: en un cuidador independiente, la misma persona queda también como cuidadora (perfil único).
  IF public.app_org_is_independent(v_inv.organization_id) THEN
    PERFORM public.app_independent_provision_operator(v_user, v_inv.organization_id, v_membership, v_inv.id);
  END IF;

  UPDATE public.access_invitations AS target_invitation
  SET status='accepted', accepted_at=now(), updated_at=now()
  WHERE target_invitation.id = v_inv.id;

  RETURN QUERY SELECT v_user, v_inv.organization_id, 'organization_admin'::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;

REVOKE ALL ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) TO app_runtime;

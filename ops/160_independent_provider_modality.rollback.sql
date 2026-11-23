-- Reversión de 160: restaura app_activate_organization_admin_invitation exactamente como en la 085 y retira
-- el interruptor, los guardas y el procedimiento de la modalidad independiente. Ejecutar como propietario de
-- las migraciones. Si ya existieran organizaciones INDEPENDENT_PROVIDER, NO se borran: quedan sin los guardas
-- (revisarlas antes de revertir).
BEGIN;
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

  UPDATE public.access_invitations AS target_invitation
  SET status='accepted', accepted_at=now(), updated_at=now()
  WHERE target_invitation.id = v_inv.id;

  RETURN QUERY SELECT v_user, v_inv.organization_id, 'organization_admin'::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;

REVOKE ALL ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) TO app_runtime;

DROP TRIGGER IF EXISTS access_invitations_independent_guard ON access_invitations;
DROP TRIGGER IF EXISTS organization_worker_memberships_independent_guard ON organization_worker_memberships;
DROP TRIGGER IF EXISTS user_roles_independent_guard ON user_roles;
DROP TRIGGER IF EXISTS organizations_type_guard ON organizations;
DROP FUNCTION IF EXISTS app_independent_provision_operator(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app_independent_invitation_guard();
DROP FUNCTION IF EXISTS app_independent_worker_membership_guard();
DROP FUNCTION IF EXISTS app_independent_roles_guard();
DROP FUNCTION IF EXISTS app_ops_change_organization_type(uuid, organization_type_enum, text, text);
DROP FUNCTION IF EXISTS app_organization_type_guard();
DROP FUNCTION IF EXISTS app_org_is_independent(uuid);
DROP FUNCTION IF EXISTS app_platform_modality_enabled(text);
DROP TABLE IF EXISTS platform_modalities;
DELETE FROM schema_migrations WHERE filename = '160_independent_provider_modality.sql';
COMMIT;

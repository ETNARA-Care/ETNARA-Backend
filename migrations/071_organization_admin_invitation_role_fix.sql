-- Hotfix: organization administrator invitations must receive the canonical
-- ORGANIZATION_ADMIN role. The previous activation function looked for ADMIN,
-- which is not the organization role used by ETNARA's authorization model.
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
  WHERE role_record.code='ORGANIZATION_ADMIN'
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

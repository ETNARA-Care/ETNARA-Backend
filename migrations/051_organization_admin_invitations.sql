-- E.4.2: secure B2B organization administrator onboarding.
ALTER TYPE access_invitation_type_enum ADD VALUE IF NOT EXISTS 'organization_admin';

ALTER TABLE access_invitations DROP CONSTRAINT IF EXISTS access_invitations_target_matches_type;
ALTER TABLE access_invitations ADD CONSTRAINT access_invitations_target_matches_type CHECK (
  (invitation_type = 'worker' AND worker_membership_id IS NOT NULL AND care_recipient_id IS NULL AND relationship_type IS NULL)
  OR (invitation_type = 'family' AND care_recipient_id IS NOT NULL AND worker_membership_id IS NULL AND relationship_type IS NOT NULL)
  OR (invitation_type = 'organization_admin' AND worker_membership_id IS NULL AND care_recipient_id IS NULL AND relationship_type IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS access_invitations_one_pending_org_admin ON access_invitations(organization_id,lower(email)) WHERE status='pending' AND invitation_type='organization_admin';

CREATE OR REPLACE FUNCTION app_inspect_access_invitation(p_token_hash text)
RETURNS TABLE(invitation_type text,email_masked text,organization_name text,target_name text,account_exists boolean,expires_at timestamptz) AS $$
BEGIN
 RETURN QUERY SELECT ai.invitation_type::text,left(ai.email,1)||'***@'||split_part(ai.email,'@',2),o.name,
 CASE WHEN ai.invitation_type='worker' THEN coalesce(w.display_name,'Personal de cuidado') WHEN ai.invitation_type='family' THEN coalesce(cr.preferred_name,cr.first_name||' '||cr.last_name) ELSE 'Administrador de organización' END,
 EXISTS(SELECT 1 FROM public.users u WHERE lower(u.email)=lower(ai.email)),ai.expires_at
 FROM public.access_invitations ai JOIN public.organizations o ON o.id=ai.organization_id LEFT JOIN public.organization_worker_memberships owm ON owm.id=ai.worker_membership_id LEFT JOIN public.workers w ON w.id=owm.worker_id LEFT JOIN public.care_recipients cr ON cr.id=ai.care_recipient_id
 WHERE ai.token_hash=p_token_hash AND ai.status='pending' AND ai.expires_at>now() LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVITATION_NOT_AVAILABLE'; END IF;
END;$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;

CREATE OR REPLACE FUNCTION app_activate_organization_admin_invitation(p_token_hash text,p_password_hash text DEFAULT NULL,p_existing_user_id uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid,organization_id uuid,invitation_type text) AS $$
DECLARE v_inv public.access_invitations%ROWTYPE;v_existing public.users%ROWTYPE;v_user uuid;v_membership uuid;v_role uuid;
BEGIN
 SELECT * INTO v_inv FROM public.access_invitations WHERE token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND OR v_inv.invitation_type<>'organization_admin' OR v_inv.status<>'pending' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVITATION_NOT_AVAILABLE'; END IF;
 IF v_inv.expires_at<=now() THEN UPDATE public.access_invitations SET status='expired',updated_at=now() WHERE id=v_inv.id;RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVITATION_EXPIRED';END IF;
 SELECT * INTO v_existing FROM public.users WHERE lower(email)=lower(v_inv.email) LIMIT 1;
 IF FOUND THEN
  IF p_existing_user_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ACCOUNT_ALREADY_EXISTS';END IF;
  IF v_existing.id<>p_existing_user_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVITATION_IDENTITY_MISMATCH';END IF;
  IF v_existing.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ACCOUNT_DISABLED';END IF;v_user:=v_existing.id;
 ELSE
  IF p_existing_user_id IS NOT NULL OR p_password_hash IS NULL OR length(p_password_hash)<20 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVALID_ACTIVATION';END IF;
  INSERT INTO public.users(email,password_hash,status) VALUES(lower(v_inv.email),p_password_hash,'active') RETURNING id INTO v_user;
 END IF;
 INSERT INTO public.organization_memberships(user_id,organization_id,status,revoked_at,updated_at) VALUES(v_user,v_inv.organization_id,'active',NULL,now()) ON CONFLICT(user_id,organization_id) DO UPDATE SET status='active',revoked_at=NULL,updated_at=now() RETURNING id INTO v_membership;
 SELECT id INTO v_role FROM public.roles WHERE code='ADMIN' LIMIT 1;IF v_role IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='ROLE_NOT_CONFIGURED';END IF;
 INSERT INTO public.user_roles(organization_membership_id,organization_id,role_id) VALUES(v_membership,v_inv.organization_id,v_role) ON CONFLICT(organization_membership_id,role_id) DO NOTHING;
 UPDATE public.access_invitations SET status='accepted',accepted_at=now(),updated_at=now() WHERE id=v_inv.id;
 RETURN QUERY SELECT v_user,v_inv.organization_id,'organization_admin'::text;
END;$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_activate_organization_admin_invitation(text,text,uuid) TO app_runtime;

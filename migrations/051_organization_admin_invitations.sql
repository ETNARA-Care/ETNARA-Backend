-- E.4.2: secure B2B organization administrator onboarding.
ALTER TYPE access_invitation_type_enum ADD VALUE IF NOT EXISTS 'organization_admin';

ALTER TABLE access_invitations DROP CONSTRAINT IF EXISTS access_invitations_target_matches_type;
ALTER TABLE access_invitations ADD CONSTRAINT access_invitations_target_matches_type CHECK (
  (invitation_type = 'worker' AND worker_membership_id IS NOT NULL AND care_recipient_id IS NULL AND relationship_type IS NULL)
  OR (invitation_type = 'family' AND care_recipient_id IS NOT NULL AND worker_membership_id IS NULL AND relationship_type IS NOT NULL)
  OR (invitation_type = 'organization_admin' AND worker_membership_id IS NULL AND care_recipient_id IS NULL AND relationship_type IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS access_invitations_one_pending_org_admin
ON access_invitations (organization_id, lower(email))
WHERE status = 'pending' AND invitation_type = 'organization_admin';

-- Extend activation so an organization-admin invitation grants ADMIN only in
-- the invitation's organization. Existing identity matching and single-use
-- token protections remain enforced by app_activate_access_invitation.
CREATE OR REPLACE FUNCTION app_e42_grant_org_admin(
  p_user_id uuid, p_organization_id uuid
) RETURNS void AS $$
DECLARE v_membership_id uuid; v_role_id uuid;
BEGIN
  INSERT INTO public.organization_memberships (user_id, organization_id, status, revoked_at, updated_at)
  VALUES (p_user_id, p_organization_id, 'active', NULL, now())
  ON CONFLICT (user_id, organization_id) DO UPDATE SET status='active', revoked_at=NULL, updated_at=now()
  RETURNING id INTO v_membership_id;
  SELECT id INTO v_role_id FROM public.roles WHERE code='ADMIN' LIMIT 1;
  IF v_role_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROLE_NOT_CONFIGURED'; END IF;
  INSERT INTO public.organization_membership_roles (membership_id, role_id)
  VALUES (v_membership_id, v_role_id) ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION app_e42_grant_org_admin(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_e42_grant_org_admin(uuid,uuid) TO app_runtime;

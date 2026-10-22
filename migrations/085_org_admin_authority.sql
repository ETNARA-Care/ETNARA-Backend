-- Phase 12.2: the agency administrator manages its own team, and money is
-- for administrators only.
--
-- 1. Authority helpers (SECURITY DEFINER, fixed search_path) so policies on
--    user_roles / organization_memberships can check roles without recursing.
-- 2. Close a privilege gap: user_roles and organization_memberships had a
--    single permissive FOR ALL policy with no WITH CHECK, so any active member
--    (a caregiver or a family member) could INSERT/UPDATE/DELETE role and
--    membership rows in their own organization directly. No application code
--    writes these tables as app_runtime; every legitimate write goes through
--    SECURITY DEFINER activation functions, which bypass RLS. RESTRICTIVE
--    write policies now require an organization administrator (or the
--    platform), and a supervisor may grant only WORKER or FAMILY roles.
-- 3. Staff invitations: access_invitations of type 'organization_admin' gain
--    staff_role (ORGANIZATION_ADMIN | SUPERVISOR). Only an organization
--    administrator (or the platform) may create, read or change them; a
--    supervisor can no longer create an administrator invitation.
-- 4. Hours, rates and pay periods are restricted to organization
--    administrators (supervisors keep operations, residents, staff, incidents).

-- 1. Helpers --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
        JOIN public.organization_memberships om ON om.id = ur.organization_membership_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND ur.organization_id = om.organization_id
          AND om.status = 'active'
          AND r.code = 'ORGANIZATION_ADMIN'
    );
$$;

CREATE OR REPLACE FUNCTION public.app_is_org_manager_definer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
        JOIN public.organization_memberships om ON om.id = ur.organization_membership_id
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND ur.organization_id = om.organization_id
          AND om.status = 'active'
          AND r.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    );
$$;

CREATE OR REPLACE FUNCTION public.app_role_code(p_role_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT r.code FROM public.roles r WHERE r.id = p_role_id;
$$;

REVOKE ALL ON FUNCTION public.app_is_org_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_is_org_manager_definer() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_role_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_is_org_admin() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_is_org_manager_definer() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_role_code(uuid) TO app_runtime;

-- 2. Role and membership writes ------------------------------------------
DROP POLICY IF EXISTS user_roles_insert_authority ON user_roles;
CREATE POLICY user_roles_insert_authority ON user_roles
    AS RESTRICTIVE FOR INSERT TO app_runtime
    WITH CHECK (
        app_is_superadmin()
        OR (app_is_org_admin() AND app_role_code(role_id) <> 'PLATFORM_SUPERADMIN')
        OR (app_is_org_manager_definer() AND app_role_code(role_id) IN ('WORKER', 'FAMILY'))
    );

DROP POLICY IF EXISTS user_roles_update_authority ON user_roles;
CREATE POLICY user_roles_update_authority ON user_roles
    AS RESTRICTIVE FOR UPDATE TO app_runtime
    USING (app_is_superadmin() OR app_is_org_admin())
    WITH CHECK (app_is_superadmin() OR (app_is_org_admin() AND app_role_code(role_id) <> 'PLATFORM_SUPERADMIN'));

DROP POLICY IF EXISTS user_roles_delete_authority ON user_roles;
CREATE POLICY user_roles_delete_authority ON user_roles
    AS RESTRICTIVE FOR DELETE TO app_runtime
    USING (app_is_superadmin() OR app_is_org_admin());

DROP POLICY IF EXISTS organization_memberships_insert_authority ON organization_memberships;
CREATE POLICY organization_memberships_insert_authority ON organization_memberships
    AS RESTRICTIVE FOR INSERT TO app_runtime
    WITH CHECK (app_is_superadmin() OR app_is_org_admin());

DROP POLICY IF EXISTS organization_memberships_update_authority ON organization_memberships;
CREATE POLICY organization_memberships_update_authority ON organization_memberships
    AS RESTRICTIVE FOR UPDATE TO app_runtime
    USING (app_is_superadmin() OR app_is_org_admin())
    WITH CHECK (app_is_superadmin() OR app_is_org_admin());

DROP POLICY IF EXISTS organization_memberships_delete_authority ON organization_memberships;
CREATE POLICY organization_memberships_delete_authority ON organization_memberships
    AS RESTRICTIVE FOR DELETE TO app_runtime
    USING (app_is_superadmin() OR app_is_org_admin());

-- 3. Staff invitations ----------------------------------------------------
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS staff_role text NULL;
UPDATE access_invitations SET staff_role = 'ORGANIZATION_ADMIN'
WHERE invitation_type = 'organization_admin' AND staff_role IS NULL;

ALTER TABLE access_invitations DROP CONSTRAINT IF EXISTS access_invitations_staff_role_valid;
ALTER TABLE access_invitations ADD CONSTRAINT access_invitations_staff_role_valid CHECK (
    (invitation_type = 'organization_admin' AND staff_role IN ('ORGANIZATION_ADMIN', 'SUPERVISOR'))
    OR (invitation_type <> 'organization_admin' AND staff_role IS NULL)
);

-- Callers that predate staff_role (and the platform flow) keep inviting administrators.
CREATE OR REPLACE FUNCTION public.app_access_invitation_default_staff_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.invitation_type = 'organization_admin' AND NEW.staff_role IS NULL THEN
        NEW.staff_role := 'ORGANIZATION_ADMIN';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_access_invitation_default_staff_role() FROM PUBLIC;

DROP TRIGGER IF EXISTS access_invitations_default_staff_role ON access_invitations;
CREATE TRIGGER access_invitations_default_staff_role
    BEFORE INSERT ON access_invitations
    FOR EACH ROW EXECUTE FUNCTION public.app_access_invitation_default_staff_role();

DROP POLICY IF EXISTS access_invitations_staff_read_authority ON access_invitations;
CREATE POLICY access_invitations_staff_read_authority ON access_invitations
    AS RESTRICTIVE FOR SELECT TO app_runtime
    USING (invitation_type <> 'organization_admin' OR app_is_superadmin() OR app_is_org_admin());

DROP POLICY IF EXISTS access_invitations_staff_insert_authority ON access_invitations;
CREATE POLICY access_invitations_staff_insert_authority ON access_invitations
    AS RESTRICTIVE FOR INSERT TO app_runtime
    WITH CHECK (invitation_type <> 'organization_admin' OR app_is_superadmin() OR app_is_org_admin());

DROP POLICY IF EXISTS access_invitations_staff_update_authority ON access_invitations;
CREATE POLICY access_invitations_staff_update_authority ON access_invitations
    AS RESTRICTIVE FOR UPDATE TO app_runtime
    USING (invitation_type <> 'organization_admin' OR app_is_superadmin() OR app_is_org_admin())
    WITH CHECK (invitation_type <> 'organization_admin' OR app_is_superadmin() OR app_is_org_admin());

-- Show the invited role on the activation page.
CREATE OR REPLACE FUNCTION app_inspect_access_invitation(p_token_hash text)
RETURNS TABLE(invitation_type text,email_masked text,organization_name text,target_name text,account_exists boolean,expires_at timestamptz) AS $$
BEGIN
 RETURN QUERY SELECT ai.invitation_type::text,left(ai.email,1)||'***@'||split_part(ai.email,'@',2),o.name,
 CASE WHEN ai.invitation_type='worker' THEN coalesce(w.display_name,'Personal de cuidado')
      WHEN ai.invitation_type='family' THEN coalesce(cr.preferred_name,cr.first_name||' '||cr.last_name)
      WHEN ai.staff_role='SUPERVISOR' THEN 'Supervisor de la organización'
      ELSE 'Administrador de organización' END,
 EXISTS(SELECT 1 FROM public.users u WHERE lower(u.email)=lower(ai.email)),ai.expires_at
 FROM public.access_invitations ai JOIN public.organizations o ON o.id=ai.organization_id LEFT JOIN public.organization_worker_memberships owm ON owm.id=ai.worker_membership_id LEFT JOIN public.workers w ON w.id=owm.worker_id LEFT JOIN public.care_recipients cr ON cr.id=ai.care_recipient_id
 WHERE ai.token_hash=p_token_hash AND ai.status='pending' AND ai.expires_at>now() LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVITATION_NOT_AVAILABLE'; END IF;
END;$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public;

-- Same body as 077 (lifecycle guard), except the role comes from staff_role.
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

-- 4. Money is for administrators only ------------------------------------
DROP POLICY IF EXISTS worker_financial_rates_admin_only ON worker_financial_rates;
CREATE POLICY worker_financial_rates_admin_only ON worker_financial_rates
    AS RESTRICTIVE FOR ALL TO app_runtime
    USING (app_is_org_admin()) WITH CHECK (app_is_org_admin());

DROP POLICY IF EXISTS timesheets_admin_only ON timesheets;
CREATE POLICY timesheets_admin_only ON timesheets
    AS RESTRICTIVE FOR ALL TO app_runtime
    USING (app_is_org_admin()) WITH CHECK (app_is_org_admin());

DROP POLICY IF EXISTS pay_periods_admin_only ON pay_periods;
CREATE POLICY pay_periods_admin_only ON pay_periods
    AS RESTRICTIVE FOR ALL TO app_runtime
    USING (app_is_org_admin()) WITH CHECK (app_is_org_admin());

DROP POLICY IF EXISTS pay_period_timesheets_admin_only ON pay_period_timesheets;
CREATE POLICY pay_period_timesheets_admin_only ON pay_period_timesheets
    AS RESTRICTIVE FOR ALL TO app_runtime
    USING (app_is_org_admin()) WITH CHECK (app_is_org_admin());

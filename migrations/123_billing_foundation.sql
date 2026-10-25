-- Migration 123 — ETNARA Facturación Premium F2.1: FACTURACION, permissions, security.
--
-- 1. FACTURACION joins the per-agency switches (108/115/118). Off for every
--    agency (no row is created). Only ETNARA central changes it (existing PUT,
--    reason required, organization_feature_events). It REQUIRES FINANZAS, also
--    in the database. Billing is usable only with both on
--    (app_org_billing_enabled); with FACTURACION off the history stays
--    readable (read-only mode) for whoever holds billing.view.
-- 2. billing_permissions: separate capabilities per agency administrator
--    (view, draft, issue, void, manage). Append-only: a permission is revoked,
--    never deleted. Only effective while the person is an active
--    ORGANIZATION_ADMIN of that agency. The last effective manager cannot be
--    revoked (the agency is never left without someone who can grant).
-- 3. ETNARA central can only (a) see which administrators exist and who
--    manages billing permissions, and (b) designate a billing permission
--    manager — through SECURITY DEFINER functions that return names and roles,
--    never invoices, rates or amounts. Every table here also carries the
--    RESTRICTIVE platform deny.
-- 4. Single administrator: when FACTURACION is turned on for an agency with
--    exactly one active administrator and no manager yet, that administrator
--    receives the five permissions (app_billing_bootstrap_permissions).
--
-- Additive only. No existing table is altered except the two CHECK lists.

-- 1. FACTURACION switch ---------------------------------------------------------------
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION'));

CREATE OR REPLACE FUNCTION public.app_org_billing_enabled(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.app_org_feature_enabled(p_organization_id, 'FINANZAS')
     AND public.app_org_feature_enabled(p_organization_id, 'FACTURACION');
$$;
REVOKE ALL ON FUNCTION public.app_org_billing_enabled(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_org_billing_enabled(uuid) TO app_runtime;

-- FACTURACION can only be ON while FINANZAS is on (turning FINANZAS off later is
-- allowed: billing then becomes read-only, nothing is lost).
CREATE OR REPLACE FUNCTION public.app_billing_feature_dependency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.feature_code = 'FACTURACION' AND NEW.enabled
     AND NOT public.app_org_feature_enabled(NEW.organization_id, 'FINANZAS') THEN
    RAISE EXCEPTION 'FEATURE_REQUIRES_FINANZAS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_billing_feature_dependency() FROM PUBLIC;
DROP TRIGGER IF EXISTS organization_features_billing_dependency ON organization_features;
CREATE TRIGGER organization_features_billing_dependency
  BEFORE INSERT OR UPDATE ON organization_features
  FOR EACH ROW EXECUTE FUNCTION public.app_billing_feature_dependency();

-- 2. Permissions -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_permissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  membership_id          uuid NOT NULL,
  capability             text NOT NULL CHECK (capability IN ('view', 'draft', 'issue', 'void', 'manage')),
  grant_source           text NOT NULL CHECK (grant_source IN ('manual', 'initial_single_admin', 'central_designation')),
  grant_reason           text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 3 AND 300),
  granted_by_user_id     uuid NOT NULL REFERENCES users(id),
  granted_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz NULL,
  revoked_by_user_id     uuid NULL REFERENCES users(id),
  revoke_reason          text NULL CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (membership_id, organization_id) REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT billing_permissions_revoke_shape CHECK (
    (revoked_at IS NULL) = (revoked_by_user_id IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- One live grant per person and capability.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_permissions_live
  ON billing_permissions (membership_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_permissions_org ON billing_permissions (organization_id, capability) WHERE revoked_at IS NULL;

-- Is this membership an active ORGANIZATION_ADMIN of that agency right now?
CREATE OR REPLACE FUNCTION public.app_membership_is_org_admin(p_organization_id uuid, p_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE om.id = p_membership_id AND om.organization_id = p_organization_id
      AND om.status = 'active' AND r.code = 'ORGANIZATION_ADMIN');
$$;

-- Live grants whose holder is still an active administrator (the only ones that count).
CREATE OR REPLACE FUNCTION public.app_billing_effective_holders(p_organization_id uuid, p_capability text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::int FROM public.billing_permissions p
  WHERE p.organization_id = p_organization_id AND p.capability = p_capability AND p.revoked_at IS NULL
    AND public.app_membership_is_org_admin(p.organization_id, p.membership_id);
$$;

-- Can the CURRENT session do <capability> in this agency? view also works in
-- read-only mode (FACTURACION or FINANZAS off); everything else needs both on.
CREATE OR REPLACE FUNCTION public.app_billing_can(p_organization_id uuid, p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     AND p_organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
     AND (p_capability = 'view' OR public.app_org_billing_enabled(p_organization_id))
     AND EXISTS (
       SELECT 1 FROM public.billing_permissions p
       JOIN public.organization_memberships om ON om.id = p.membership_id AND om.organization_id = p.organization_id
       WHERE p.organization_id = p_organization_id AND p.capability = p_capability AND p.revoked_at IS NULL
         AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
         AND public.app_membership_is_org_admin(p.organization_id, p.membership_id));
$$;

CREATE OR REPLACE FUNCTION public.app_billing_permission_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.current_user_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BILLING_PERMISSION_NO_DELETE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
      RAISE EXCEPTION 'BILLING_PERMISSION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    -- Only agency administrators can hold billing permissions (never supervisors,
    -- caregivers, relatives or another agency's people).
    IF NOT public.app_membership_is_org_admin(NEW.organization_id, NEW.membership_id) THEN
      RAISE EXCEPTION 'BILLING_PERMISSION_ADMIN_ONLY' USING ERRCODE = '23514';
    END IF;
    IF v_actor IS NOT NULL AND NEW.granted_by_user_id::text <> v_actor THEN
      RAISE EXCEPTION 'BILLING_PERMISSION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: only a revocation, once.
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.membership_id <> OLD.membership_id
     OR NEW.capability <> OLD.capability OR NEW.grant_source <> OLD.grant_source OR NEW.grant_reason <> OLD.grant_reason
     OR NEW.granted_by_user_id <> OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'BILLING_PERMISSION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF v_actor IS NOT NULL AND NEW.revoked_by_user_id::text <> v_actor THEN
    RAISE EXCEPTION 'BILLING_PERMISSION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- Never leave the agency without an effective permission manager. Serialised
  -- per agency so two administrators revoking each other at once cannot both pass.
  IF OLD.capability = 'manage' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'billing-manage', OLD.organization_id), 123));
    IF public.app_membership_is_org_admin(OLD.organization_id, OLD.membership_id)
       AND public.app_billing_effective_holders(OLD.organization_id, 'manage') <= 1 THEN
      RAISE EXCEPTION 'LAST_PERMISSION_MANAGER' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS billing_permissions_guard ON billing_permissions;
CREATE TRIGGER billing_permissions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON billing_permissions
  FOR EACH ROW EXECUTE FUNCTION public.app_billing_permission_guard();

ALTER TABLE billing_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_permissions FROM app_runtime;
DROP POLICY IF EXISTS billing_permissions_admin_read ON billing_permissions;
-- Administrators of the agency see who holds which permission (no amounts here).
CREATE POLICY billing_permissions_admin_read ON billing_permissions FOR SELECT TO app_runtime
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND public.app_is_org_admin());
DROP POLICY IF EXISTS billing_permissions_manage_insert ON billing_permissions;
CREATE POLICY billing_permissions_manage_insert ON billing_permissions FOR INSERT TO app_runtime
  WITH CHECK (grant_source = 'manual' AND public.app_billing_can(organization_id, 'manage'));
DROP POLICY IF EXISTS billing_permissions_manage_update ON billing_permissions;
CREATE POLICY billing_permissions_manage_update ON billing_permissions FOR UPDATE TO app_runtime
  USING (public.app_billing_can(organization_id, 'manage'))
  WITH CHECK (public.app_billing_can(organization_id, 'manage'));
DROP POLICY IF EXISTS platform_finance_deny ON billing_permissions;
CREATE POLICY platform_finance_deny ON billing_permissions AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());
GRANT SELECT, INSERT ON billing_permissions TO app_runtime;
GRANT UPDATE (revoked_at, revoked_by_user_id, revoke_reason) ON billing_permissions TO app_runtime;

-- Administrators of the agency and their live billing permissions, for the
-- agency's own permissions screen (email only; requires billing.view or manage).
CREATE OR REPLACE FUNCTION public.app_billing_admins(p_organization_id uuid)
RETURNS TABLE (membership_id uuid, email text, is_me boolean, capabilities text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT (public.app_billing_can(p_organization_id, 'manage') OR public.app_billing_can(p_organization_id, 'view')) THEN
    RAISE EXCEPTION 'BILLING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT om.id, u.email::text, om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid,
         COALESCE((SELECT array_agg(p.capability ORDER BY p.capability) FROM public.billing_permissions p
                   WHERE p.membership_id = om.id AND p.revoked_at IS NULL), '{}')
  FROM public.organization_memberships om
  JOIN public.users u ON u.id = om.user_id
  WHERE om.organization_id = p_organization_id
    AND public.app_membership_is_org_admin(p_organization_id, om.id)
  ORDER BY u.email;
END;
$$;

-- 3. ETNARA central: candidates and designation (names and roles only) -----------------
CREATE OR REPLACE FUNCTION public.app_platform_billing_admins(p_organization_id uuid)
RETURNS TABLE (membership_id uuid, email text, is_manager boolean, capabilities text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_is_superadmin() THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT om.id, u.email::text,
         EXISTS (SELECT 1 FROM public.billing_permissions p WHERE p.membership_id = om.id AND p.capability = 'manage' AND p.revoked_at IS NULL),
         COALESCE((SELECT array_agg(p.capability ORDER BY p.capability) FROM public.billing_permissions p
                   WHERE p.membership_id = om.id AND p.revoked_at IS NULL), '{}')
  FROM public.organization_memberships om
  JOIN public.users u ON u.id = om.user_id
  WHERE om.organization_id = p_organization_id
    AND public.app_membership_is_org_admin(p_organization_id, om.id)
  ORDER BY u.email;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_platform_designate_billing_manager(p_organization_id uuid, p_membership_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_cap text;
  v_added integer := 0;
BEGIN
  IF NOT public.app_is_superadmin() OR v_actor IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF NOT public.app_org_billing_enabled(p_organization_id) THEN
    RAISE EXCEPTION 'FEATURE_NOT_ENABLED' USING ERRCODE = '55000';
  END IF;
  IF NOT public.app_membership_is_org_admin(p_organization_id, p_membership_id) THEN
    RAISE EXCEPTION 'BILLING_PERMISSION_ADMIN_ONLY' USING ERRCODE = '23514';
  END IF;
  -- Manager + view (to see the permissions screen). Never draft/issue/void:
  -- the designated manager grants those inside the agency.
  FOREACH v_cap IN ARRAY ARRAY['manage', 'view'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.billing_permissions
                   WHERE membership_id = p_membership_id AND capability = v_cap AND revoked_at IS NULL) THEN
      INSERT INTO public.billing_permissions (organization_id, membership_id, capability, grant_source, grant_reason, granted_by_user_id)
      VALUES (p_organization_id, p_membership_id, v_cap, 'central_designation', p_reason, v_actor);
      v_added := v_added + 1;
    END IF;
  END LOOP;
  INSERT INTO public.finance_events (organization_id, actor_user_id, action, entity_type, entity_id, new_value)
  VALUES (p_organization_id, v_actor, 'FINANCE_BILLING_MANAGER_DESIGNATED', 'organization_membership', p_membership_id,
          jsonb_build_object('reason', p_reason, 'granted', v_added, 'source', 'central_designation'));
  INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id)
  VALUES (v_actor, p_organization_id, p_organization_id, 'FINANCE_BILLING_MANAGER_DESIGNATED', 'organization_membership', p_membership_id);
  RETURN v_added;
END;
$$;

-- 4. Single administrator gets the initial permissions when FACTURACION is turned on.
CREATE OR REPLACE FUNCTION public.app_billing_bootstrap_permissions(p_organization_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_admins uuid[];
  v_cap text;
  v_added integer := 0;
BEGIN
  IF NOT public.app_is_superadmin() OR v_actor IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.app_org_billing_enabled(p_organization_id)
     OR public.app_billing_effective_holders(p_organization_id, 'manage') > 0 THEN
    RETURN 0;
  END IF;
  SELECT array_agg(om.id) INTO v_admins FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id AND public.app_membership_is_org_admin(p_organization_id, om.id);
  IF v_admins IS NULL OR array_length(v_admins, 1) <> 1 THEN
    RETURN 0;  -- several (or no) administrators: ETNARA central designates the manager
  END IF;
  FOREACH v_cap IN ARRAY ARRAY['view', 'draft', 'issue', 'void', 'manage'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.billing_permissions
                   WHERE membership_id = v_admins[1] AND capability = v_cap AND revoked_at IS NULL) THEN
      INSERT INTO public.billing_permissions (organization_id, membership_id, capability, grant_source, grant_reason, granted_by_user_id)
      VALUES (p_organization_id, v_admins[1], v_cap, 'initial_single_admin', 'Permisos iniciales: único administrador de la agencia', v_actor);
      v_added := v_added + 1;
    END IF;
  END LOOP;
  IF v_added > 0 THEN
    INSERT INTO public.finance_events (organization_id, actor_user_id, action, entity_type, entity_id, new_value)
    VALUES (p_organization_id, v_actor, 'FINANCE_BILLING_INITIAL_PERMISSIONS', 'organization_membership', v_admins[1],
            jsonb_build_object('granted', v_added, 'source', 'initial_single_admin'));
    INSERT INTO public.audit_log (actor_user_id, organization_id, target_organization_id, action, entity_type, entity_id)
    VALUES (v_actor, p_organization_id, p_organization_id, 'FINANCE_BILLING_INITIAL_PERMISSIONS', 'organization_membership', v_admins[1]);
  END IF;
  RETURN v_added;
END;
$$;

REVOKE ALL ON FUNCTION public.app_membership_is_org_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_billing_effective_holders(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_billing_can(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_billing_permission_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_platform_billing_admins(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_billing_admins(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_platform_designate_billing_manager(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_billing_bootstrap_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_membership_is_org_admin(uuid, uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_billing_effective_holders(uuid, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_billing_can(uuid, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_platform_billing_admins(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_billing_admins(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_platform_designate_billing_manager(uuid, uuid, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_billing_bootstrap_permissions(uuid) TO app_runtime;

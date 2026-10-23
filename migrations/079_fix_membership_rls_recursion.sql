-- Migration 079: break recursive RLS evaluation in app_has_active_membership().
--
-- Migration 069 made organization_memberships depend on
-- app_has_active_membership(), while the helper itself queries
-- organization_memberships. Under app_runtime that creates infinite RLS
-- recursion (PostgreSQL 54001: stack depth limit exceeded).
--
-- SECURITY DEFINER is limited to this boolean membership lookup. The
-- function accepts no caller-provided identifiers and uses only the
-- authenticated session context. A fixed search_path prevents object
-- shadowing inside the privileged function.

CREATE OR REPLACE FUNCTION public.app_has_active_membership()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
          AND om.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND om.status = 'active'
    );
$$;

REVOKE ALL ON FUNCTION public.app_has_active_membership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_has_active_membership() TO app_runtime;

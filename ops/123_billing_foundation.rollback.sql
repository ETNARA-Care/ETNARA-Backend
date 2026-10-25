-- ROLLBACK of migration 123 (ETNARA Facturación Premium F2.1).
-- Run ONLY as the database owner, in one go. A code-only rollback does NOT need
-- it: the previous backend never reads billing_permissions and never sends
-- FACTURACION. Stops, changing nothing, if any agency has FACTURACION recorded
-- (on or off) or any billing permission exists: those are audit history and
-- must be kept. Finanzas (119/121) and its data are not touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_features WHERE feature_code = 'FACTURACION')
     OR EXISTS (SELECT 1 FROM organization_feature_events WHERE feature_code = 'FACTURACION')
     OR EXISTS (SELECT 1 FROM billing_permissions) THEN
    RAISE EXCEPTION 'FACTURACION history or billing permissions exist: rollback aborted, nothing changed';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.app_billing_bootstrap_permissions(uuid);
DROP FUNCTION IF EXISTS public.app_platform_designate_billing_manager(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.app_platform_billing_admins(uuid);
DROP FUNCTION IF EXISTS public.app_billing_admins(uuid);
DROP TABLE IF EXISTS billing_permissions;
DROP FUNCTION IF EXISTS public.app_billing_permission_guard();
DROP FUNCTION IF EXISTS public.app_billing_can(uuid, text);
DROP FUNCTION IF EXISTS public.app_billing_effective_holders(uuid, text);
DROP FUNCTION IF EXISTS public.app_membership_is_org_admin(uuid, uuid);
DROP TRIGGER IF EXISTS organization_features_billing_dependency ON organization_features;
DROP FUNCTION IF EXISTS public.app_billing_feature_dependency();
DROP FUNCTION IF EXISTS public.app_org_billing_enabled(uuid);

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS'));

DELETE FROM schema_migrations WHERE filename = '123_billing_foundation.sql';

COMMIT;

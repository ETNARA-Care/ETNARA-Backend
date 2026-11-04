-- Reversal of 146 (Web Push). Run as the migrations superuser AFTER the backend has gone
-- back to code without the push module (or with PUSH_ENABLED=off: the 146 code only calls
-- these functions when sending is on, and /me/push/* would answer 500 without them).
--
-- What is lost: the phones people activated (they must activate again if 146 returns),
-- their push preferences, the queue and the delivery history, and the
-- PUSH_NOTIFICATIONS switch rows (and their feature events) for every agency.
-- Notifications themselves (the in-app inbox) are NOT touched.
-- The audit of subscription changes (push_subscription_events) is exported first by the
-- operator if it must be kept: see ops/146_web_push_activacion.md, step R2.
BEGIN;
DROP TRIGGER IF EXISTS notifications_push_enqueue ON notifications;
DROP TRIGGER IF EXISTS sessions_push_cleanup ON sessions;
DROP TRIGGER IF EXISTS organizations_push_cleanup ON organizations;

DROP FUNCTION IF EXISTS public.app_push_cleanup();
DROP FUNCTION IF EXISTS public.app_push_report(uuid, integer);
DROP FUNCTION IF EXISTS public.app_push_claim(integer);
DROP FUNCTION IF EXISTS public.app_push_expand(integer);
DROP FUNCTION IF EXISTS public.app_push_on_organization_lifecycle();
DROP FUNCTION IF EXISTS public.app_push_revoke_for_organization(uuid, text);
DROP FUNCTION IF EXISTS public.app_push_on_session_revoked();
DROP FUNCTION IF EXISTS public.app_push_enqueue();
DROP FUNCTION IF EXISTS public.app_push_test();
DROP FUNCTION IF EXISTS public.app_push_unregister(text);
DROP FUNCTION IF EXISTS public.app_push_register(uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.app_push_resolve(uuid, boolean);
DROP FUNCTION IF EXISTS public.app_push_user_has_access(uuid);

DROP TABLE IF EXISTS push_deliveries;
DROP TABLE IF EXISTS push_outbox;
DROP TABLE IF EXISTS push_subscription_events;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS push_preferences;
DROP TABLE IF EXISTS push_notification_catalog;

DELETE FROM organization_feature_events WHERE feature_code = 'PUSH_NOTIFICATIONS';
DELETE FROM organization_features WHERE feature_code = 'PUSH_NOTIFICATIONS';
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS'));
COMMIT;

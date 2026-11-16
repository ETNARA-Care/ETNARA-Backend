-- ROLLBACK of migration 155 (SmartMatch «Hay una nueva oportunidad»).
-- Removes the trigger, its function, the dedupe index and the catalog row. Notices already
-- in the bell are kept (history); push not yet sent is dropped by the resolver
-- (TYPE_NOT_ALLOWED) once the catalog row is gone. No other data is touched.
--   psql "$MIGRATIONS_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ops/155_smartmatch_new_opportunity_push.rollback.sql
-- Unregisters 155 (repo convention since 150) so a later deploy can re-apply it.
DROP TRIGGER IF EXISTS smartmatch_opportunity_publish_notify ON smartmatch_opportunities;
DROP FUNCTION IF EXISTS public.app_smartmatch_opportunity_publish_notify();
DROP INDEX IF EXISTS idx_notifications_smartmatch_published_once;
DELETE FROM push_notification_catalog WHERE notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED';
DELETE FROM schema_migrations WHERE filename = '155_smartmatch_new_opportunity_push.sql';

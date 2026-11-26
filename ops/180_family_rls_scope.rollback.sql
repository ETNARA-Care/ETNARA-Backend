-- Reversión de 180 (seguridad: alcance de la familia en la RLS). Ejecutar como propietario de las migraciones, solo con
-- autorización expresa. Sin datos que conservar: quita las políticas y funciones nuevas y deja el esquema como antes.
BEGIN;
DROP POLICY IF EXISTS family_scope_own_user ON users;
DROP POLICY IF EXISTS family_scope_shifts ON shifts;
DROP POLICY IF EXISTS family_scope_assignments ON assignments;
DROP POLICY IF EXISTS family_scope_worker_memberships ON organization_worker_memberships;
DROP POLICY IF EXISTS family_scope_workers ON workers;
DROP POLICY IF EXISTS family_scope_credentials ON credentials;
DROP POLICY IF EXISTS family_scope_deny ON worker_unavailability_periods;
DROP POLICY IF EXISTS family_scope_deny ON establishment_worker_assignments;
DROP FUNCTION IF EXISTS public.app_family_visible_worker(uuid);
DROP FUNCTION IF EXISTS public.app_family_visible_membership(uuid);
DROP FUNCTION IF EXISTS public.app_family_recipient_shift(uuid);
DROP FUNCTION IF EXISTS public.app_family_has_recipient(uuid);
DROP FUNCTION IF EXISTS public.app_family_only_member();
DELETE FROM schema_migrations WHERE filename = '180_family_rls_scope.sql';
COMMIT;

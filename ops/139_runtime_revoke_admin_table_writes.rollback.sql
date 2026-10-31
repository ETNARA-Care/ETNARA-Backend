-- Reversión de 139: devuelve a app_runtime exactamente los privilegios que tenía después de 138
-- (INSERT, UPDATE y DELETE en las 7 tablas administrativas sin RLS). Ejecutar como el superusuario
-- de migraciones. No toca datos. La aplicación no depende de estos privilegios, así que no hace falta
-- revertir código antes.
BEGIN;
GRANT INSERT, UPDATE, DELETE ON TABLE
  public.platform_admins,
  public.roles,
  public.role_permissions,
  public.permissions,
  public.credential_types,
  public.verification_methods,
  public.schema_migrations
TO app_runtime;
DELETE FROM schema_migrations WHERE filename = '139_runtime_revoke_admin_table_writes.sql';
COMMIT;

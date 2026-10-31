-- 139: app_runtime no escribe en las tablas administrativas sin RLS (dictamen app_runtime, 31-oct-2026).
--
-- 017 concedió SELECT, INSERT, UPDATE y DELETE sobre TODAS las tablas de entonces. Siete de ellas no
-- tienen RLS y son de control de la plataforma: quién es superadministrador de ETNARA, los roles y sus
-- permisos, los catálogos de credenciales y de verificación, y el registro de migraciones. La aplicación
-- solo las LEE (comprobado en el código y en el manifiesto de privilegios); solo el bootstrap, que se
-- conecta como el superusuario de migraciones, escribe en ellas. Con app_runtime activo, un fallo de
-- inyección SQL podría, por ejemplo, darse acceso de superadministrador.
--
-- Qué cambia: app_runtime pierde INSERT, UPDATE y DELETE en esas 7 tablas. Conserva SELECT.
-- Nada más cambia: ni datos, ni otras tablas, ni funciones. Mientras producción use postgres no tiene
-- ningún efecto. Idempotente (REVOKE de algo ya revocado no falla).
-- Reversión: ops/139_runtime_revoke_admin_table_writes.rollback.sql

REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.platform_admins,
  public.roles,
  public.role_permissions,
  public.permissions,
  public.credential_types,
  public.verification_methods,
  public.schema_migrations
FROM app_runtime;

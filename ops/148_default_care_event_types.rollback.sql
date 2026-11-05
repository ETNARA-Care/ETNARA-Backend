-- Reversión ESTÁNDAR de 148 (tipos de registro de cuidado por defecto). Ejecutar como el
-- superusuario de migraciones. No requiere volver a desplegar: el código no llama a nada de 148.
--
-- Qué hace: retira el disparador, las funciones y el registro care_event_type_default_grants.
-- El esquema queda idéntico al de 147.
-- Qué CONSERVA: las filas de organization_care_event_types que creó 148. Así ninguna agencia
-- vuelve a quedarse sin poder registrar cuidados (A1); es la misma configuración que tiene
-- Casa Demo y la que pondría la administración. Las agencias que se creen después de esta
-- reversión vuelven a nacer SIN tipos (comportamiento de 147).
--
-- Para retirar también esas filas, usar 148_default_care_event_types.rollback_full.sql
-- ANTES de este archivo (lo incluye).
BEGIN;
DROP TRIGGER IF EXISTS organizations_default_care_event_types ON organizations;
DROP FUNCTION IF EXISTS public.app_on_organization_created_care_event_types();
DROP FUNCTION IF EXISTS public.app_provision_default_care_event_types(uuid, text);
DROP FUNCTION IF EXISTS public.app_default_care_event_type_codes();
DROP TABLE IF EXISTS care_event_type_default_grants;
DELETE FROM schema_migrations WHERE filename = '148_default_care_event_types.sql';
COMMIT;

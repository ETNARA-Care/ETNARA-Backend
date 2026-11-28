-- Reversión de 181_connect_integration. Elimina SOLO lo de la integración con Connect; no toca organizaciones,
-- cuentas, sesiones ni el inicio de sesión. Tras revertir, apagar CONNECT_INTEGRATION (las rutas responden 404).
BEGIN;
DROP TRIGGER IF EXISTS organizations_connect_status ON public.organizations;
DROP FUNCTION IF EXISTS public.app_connect_org_status_trigger();
DROP FUNCTION IF EXISTS public.app_connect_outbox_report(bigint, integer);
DROP FUNCTION IF EXISTS public.app_connect_outbox_claim(integer);
DROP FUNCTION IF EXISTS public.app_connect_status_by_ref(text);
DROP FUNCTION IF EXISTS public.app_connect_redeem_link_code(text, text);
DROP FUNCTION IF EXISTS public.app_connect_unlink();
DROP FUNCTION IF EXISTS public.app_connect_link_status();
DROP FUNCTION IF EXISTS public.app_connect_create_link_code(text);
DROP FUNCTION IF EXISTS public.app_connect_org_facts(uuid);
DROP TABLE IF EXISTS public.connect_outbox;
DROP TABLE IF EXISTS public.connect_links;
DROP TABLE IF EXISTS public.connect_link_codes;
DELETE FROM public.schema_migrations WHERE filename = '181_connect_integration.sql';
COMMIT;

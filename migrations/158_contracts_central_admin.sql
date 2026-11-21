-- 158: herramientas de ETNARA Central para administrar contratos sin consola de base de datos. 21-nov-2026.
-- Preparación local; nada se activa. Reutiliza el módulo contractual (152/153/156/157) sin reconstruirlo.
--
-- 1) Documentos de PRUEBA dirigidos a UNA agencia. Hasta ahora solo la Orden de Suscripción podía
--    tener agencia; un documento de prueba era general y lo veía toda agencia con «Contratos» encendido.
--    Ahora un documento de prueba puede quedar limitado a una agencia. Los documentos oficiales (no de
--    prueba) siguen siendo generales, salvo la Orden, que sigue exigiendo su agencia.
--    El aislamiento ya lo aplica la base desde 153 para cualquier documento con agencia: la política
--    de lectura de versiones (app_contract_document_org), la guarda de aceptaciones (rechaza firmar un
--    documento de otra agencia) y la regla de documentos obligatorios. Aquí solo cambia qué filas se
--    permiten; el documento sigue siendo inmutable (contract_documents_immutable).
-- 2) Lista de personas que Central puede designar como representante de una agencia: administradoras
--    activas de esa agencia (misma regla que exige la designación, app_contract_acceptance_facts).
--    Solo superadministración; devuelve el identificador de la cuenta y su correo, nada más.
-- Idempotente. Reversión: ops/158_contracts_central_admin.rollback.sql (se niega si ya hay documentos
-- de prueba con agencia).

ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_order_scope;
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_scope;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_scope CHECK (
  (kind <> 'SUBSCRIPTION_ORDER' OR organization_id IS NOT NULL)
  AND (organization_id IS NULL OR kind = 'SUBSCRIPTION_ORDER' OR is_test)
);

CREATE OR REPLACE FUNCTION public.app_platform_contract_eligible_signatories(p_organization_id uuid)
RETURNS TABLE (user_id uuid, email text)
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
  SELECT DISTINCT u.id, u.email::text
    FROM public.organization_memberships om
    JOIN public.users u ON u.id = om.user_id
   WHERE om.organization_id = p_organization_id
     AND om.status = 'active'
     AND (SELECT f.is_active_admin FROM public.app_contract_acceptance_facts(u.id, p_organization_id) f)
   ORDER BY u.email::text;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_contract_eligible_signatories(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_contract_eligible_signatories(uuid) TO app_runtime;

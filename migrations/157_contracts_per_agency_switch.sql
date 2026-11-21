-- 157: interruptor «Contratos» por agencia (CONTRACTS). 21-nov-2026. Preparación local; nada se activa.
-- Reutiliza los interruptores por agencia de ETNARA Central (108): apagado por defecto, cada cambio con
-- motivo y registrado en organization_feature_events (solo se añade).
--
-- Se SUMA a los controles globales; no los reemplaza ni los salta:
--   * CONTRACTS_MODULE (servidor) sigue mandando: apagado, todas las rutas responden 404 aunque la
--     agencia tenga el interruptor encendido;
--   * aprobación jurídica, publicación oficial (CONTRACTS_OFFICIAL_PUBLISHING), representante
--     designada, código de verificación, firmas de prueba y reglas de acceso (CONTRACTS_ENFORCEMENT) no
--     cambian: el interruptor solo DECIDE QUÉ AGENCIAS pueden usar el módulo.
--   * La base exige el interruptor para crear códigos de firma, aceptaciones del contrato, descargas
--     registradas y aceptaciones de términos por función desde la aplicación (app_runtime). Apagarlo
--     impide nuevas aceptaciones; NO borra ni cambia contratos, versiones, aceptaciones ni constancias.
--   * Las operaciones de ETNARA Central sobre el catálogo (crear, aprobar, publicar, retirar, designar)
--     no dependen del interruptor de ninguna agencia.
-- Idempotente. Reversión: ops/157_contracts_per_agency_switch.rollback.sql.

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS'));

-- Desde la aplicación, nuevas evidencias contractuales solo en agencias con CONTRACTS encendido.
-- (Las migraciones y reversiones, que corren como propietario, no pasan por aquí.)
CREATE OR REPLACE FUNCTION public.app_contract_org_switch_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (current_user = 'app_runtime' OR session_user = 'app_runtime')
     AND NOT public.app_org_feature_enabled(NEW.organization_id, 'CONTRACTS') THEN
    RAISE EXCEPTION 'CONTRACT_ORGANIZATION_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_contract_org_switch_guard() FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_signature_challenges', 'organization_contract_acceptances', 'contract_document_downloads', 'user_role_terms_acceptances'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_org_switch_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION public.app_contract_org_switch_guard()', t || '_org_switch_guard', t);
  END LOOP;
END $$;

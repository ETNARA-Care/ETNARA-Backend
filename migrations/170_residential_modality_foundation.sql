-- 170 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F0: base de aislamiento. 24-nov-2026.
--
-- Fuente oficial: «ETNARA Care · Hogares de envejecientes: plan de implementación definitivo» (D1, D9, D10).
-- Preparación aislada: nada se activa. Todo nace APAGADO.
--
-- Contenido:
--   1. app_org_is_residential(uuid): ¿la organización es un hogar? (SECURITY DEFINER, solo un booleano).
--   2. Cuatro códigos nuevos en los interruptores por organización (108/157), apagados por defecto:
--        HOGAR_CALENDARIO, HOGAR_ASIGNACIONES, HOGAR_PONCHES (módulos de hogar, F1–F5)
--        DEMO_ENVIRONMENT (franja «Entorno de demostración — Datos ficticios», D9)
--   3. Guarda de modalidad en organization_features (defensa en profundidad, también para el superusuario):
--        * HOGAR_* y DEMO_ENVIRONMENT solo se pueden ENCENDER en organizaciones RESIDENTIAL_CARE_HOME;
--        * en un hogar no se pueden ENCENDER SMARTMATCH, FINANZAS, FACTURACION ni SHIFT_REPORTS (D10 y plan §2).
--      Apagar nunca se bloquea. Las filas existentes no se modifican (D1): la guarda solo actúa al escribir.
--
-- No toca shifts, ni datos, ni ninguna otra tabla. Agencias e independientes: ningún cambio de comportamiento
-- (sus interruptores actuales siguen igual; los códigos nuevos no se les pueden encender).
-- Idempotente. Reversión: ops/170_residential_modality_foundation.rollback.sql.

-- 1. ¿Es un hogar? -----------------------------------------------------------------------------------------
-- Revisión independiente 25-nov (A3): no es un oráculo entre organizaciones. Responde solo a quien ya podría leer
-- esa organización: una sesión que no está sujeta a RLS (migraciones, ops), ETNARA Central en contexto de plataforma
-- (app_is_superadmin, que vuelve a comprobar platform_admins) o un miembro activo de esa organización (lo mismo que
-- dejan ver las políticas de organizations). A cualquier otro le responde con un error, nunca con true/false, para
-- que una guarda que la use se cierre en vez de saltarse en silencio.
CREATE OR REPLACE FUNCTION public.app_org_is_residential(p_organization_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false)
     AND NOT public.app_is_superadmin()
     AND NOT EXISTS (SELECT 1 FROM public.organization_memberships om
                     WHERE om.user_id = v_user AND om.organization_id = p_organization_id AND om.status = 'active') THEN
    RAISE EXCEPTION 'RESIDENTIAL_ORG_NOT_VISIBLE' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.organizations o
                 WHERE o.id = p_organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME');
END;
$$;
REVOKE ALL ON FUNCTION public.app_org_is_residential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_org_is_residential(uuid) TO app_runtime;

-- 2. Códigos nuevos (se conservan los ocho existentes, en el mismo orden) ----------------------------------
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS',
                          'HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS', 'CONTRACTS',
                          'HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT'));

-- 3. Guarda de modalidad ------------------------------------------------------------------------------------
-- SECURITY DEFINER (A3): la guarda lee el tipo directamente y nunca depende de quién escribe ni de su contexto.
CREATE OR REPLACE FUNCTION public.app_org_feature_modality_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_residential boolean;
BEGIN
  IF NEW.enabled IS DISTINCT FROM true THEN
    RETURN NEW; -- apagar (o crear apagado) nunca se bloquea
  END IF;
  v_residential := EXISTS (SELECT 1 FROM public.organizations o
                           WHERE o.id = NEW.organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME');
  IF NEW.feature_code IN ('HOGAR_CALENDARIO', 'HOGAR_ASIGNACIONES', 'HOGAR_PONCHES', 'DEMO_ENVIRONMENT') AND NOT v_residential THEN
    RAISE EXCEPTION 'FEATURE_NOT_AVAILABLE_FOR_MODALITY' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.feature_code IN ('SMARTMATCH', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS') AND v_residential THEN
    RAISE EXCEPTION 'FEATURE_NOT_AVAILABLE_FOR_MODALITY' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_org_feature_modality_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS organization_features_modality_guard ON organization_features;
CREATE TRIGGER organization_features_modality_guard
  BEFORE INSERT OR UPDATE OF enabled, feature_code, organization_id ON organization_features
  FOR EACH ROW EXECUTE FUNCTION public.app_org_feature_modality_guard();

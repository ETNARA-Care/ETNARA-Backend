-- 149: responsabilidad documental de la agencia (decisión de producto del 5-nov-2026).
--
-- ETNARA Central NO revisa, aprueba ni certifica documentos, licencias ni credenciales de las
-- agencias. Cada agencia revisa y aprueba lo suyo, y nadie decide sobre su propia credencial.
--
-- E. Central sin acceso ordinario a los documentos institucionales (cierre tomado del #247):
--    * se retiran las dos políticas de revisión de Central creadas en la 125;
--    * política RESTRICTIVA platform_phi_deny (la misma de la 078 para datos de residentes): un
--      superadministrador de plataforma ve 0 filas y no escribe ninguna;
--    * las columnas de revisión (review_status, reviewed_by_user_id, reviewed_at, review_reason)
--      quedan como HISTORIAL congelado: app_runtime pierde el UPDATE de esas columnas y el trigger
--      rechaza cualquier cambio. Las decisiones anteriores de Central se conservan tal cual.
--    * la agencia sigue cargando, consultando, descargando y archivando sus documentos.
--
-- B1. Las credenciales del personal son datos de la agencia: solo la gerencia (ORGANIZATION_ADMIN o
--     SUPERVISOR) crea, cambia o borra credenciales, y nunca las propias. La dueña de una credencial
--     solo puede adjuntar evidencia (document_id), y subirla devuelve la revisión a "pendiente".
-- B2. Nadie aprueba ni rechaza su propia credencial, aunque sea administradora o supervisora.
-- E2. Central tampoco lee ni escribe credenciales, revisiones ni verificaciones de plataforma.
--
-- No cambia: las credenciales, aprobaciones, documentos y versiones existentes (ningún UPDATE de
-- datos); las políticas de la agencia; el cálculo de elegibilidad. Los triggers solo actúan sobre
-- escrituras NUEVAS hechas por la aplicación (app_runtime), también dentro de funciones SECURITY
-- DEFINER llamadas por ella. Migraciones y operación (superusuario) no se ven afectadas.
-- Idempotente. Reversión: ops/149_agency_document_responsibility.rollback.sql

-- ---------------------------------------------------------------- E: documentos institucionales
DROP POLICY IF EXISTS establishment_documents_platform_review_read ON establishment_documents;
DROP POLICY IF EXISTS establishment_documents_platform_review_update ON establishment_documents;

DROP POLICY IF EXISTS platform_phi_deny ON establishment_documents;
CREATE POLICY platform_phi_deny ON establishment_documents AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin());

-- La agencia solo archiva; las columnas de revisión son historial.
REVOKE UPDATE ON establishment_documents FROM app_runtime;
GRANT UPDATE (archived_at, updated_at) ON establishment_documents TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_establishment_document_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Owner maintenance (migrations, ops) is not the application.
  IF current_user <> 'app_runtime' THEN
    RETURN NEW;
  END IF;
  -- 149: the review fields are history (decisions ETNARA Central recorded before 5-nov-2026).
  -- Nobody changes them through the application, neither the agency nor ETNARA Central.
  IF NEW.review_status IS DISTINCT FROM OLD.review_status
     OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.review_reason IS DISTINCT FROM OLD.review_reason THEN
    RAISE EXCEPTION 'ESTABLISHMENT_DOCUMENT_REVIEW_IS_HISTORICAL' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_establishment_document_update_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS establishment_documents_update_guard ON establishment_documents;
CREATE TRIGGER establishment_documents_update_guard
  BEFORE UPDATE ON establishment_documents
  FOR EACH ROW EXECUTE FUNCTION public.app_establishment_document_update_guard();

-- ---------------------------------------------------------------- E2: Central sin acceso a credenciales
-- Central no revisa, aprueba ni supervisa las credenciales del personal de las agencias. Se cierran las
-- ramas «OR app_is_superadmin()» que le dejaban leer todas las credenciales, sus revisiones (con notas),
-- el historial de revisiones por versión y escribir verificaciones de plataforma. Misma política
-- RESTRICTIVA platform_phi_deny que ya tienen documents, document_versions y stored_files.
-- La agencia (contexto de su organización) no cambia: el superadministrador solo existe en el contexto
-- de plataforma (withPlatformContext).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credentials', 'credential_platform_verifications',
                           'organization_credential_reviews', 'organization_document_version_reviews'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_phi_deny ON %I', t);
    EXECUTE format('CREATE POLICY platform_phi_deny ON %I AS RESTRICTIVE FOR ALL TO app_runtime
                      USING (NOT app_is_superadmin()) WITH CHECK (NOT app_is_superadmin())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- B1: credenciales del personal
-- Who is acting, as the application sees it. NULL outside a signed-in request.
CREATE OR REPLACE FUNCTION public.app_credential_owner_user(p_worker_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.user_id FROM workers w WHERE w.id = p_worker_id
$$;
REVOKE ALL ON FUNCTION public.app_credential_owner_user(uuid) FROM PUBLIC;
-- Called from the triggers below, which run as the application role.
GRANT EXECUTE ON FUNCTION public.app_credential_owner_user(uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_credential_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_owner uuid;
  v_evidence_only boolean := false;
BEGIN
  -- Only the application is restricted (also inside SECURITY DEFINER functions it calls).
  IF current_user <> 'app_runtime' AND session_user <> 'app_runtime' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_owner := public.app_credential_owner_user(COALESCE(NEW.worker_id, OLD.worker_id));

  IF TG_OP = 'UPDATE' THEN
    -- Attaching evidence is the only change the owner (or anyone) may make without managing data.
    v_evidence_only := NEW.worker_id = OLD.worker_id
      AND NEW.credential_type_id = OLD.credential_type_id
      AND NEW.issuing_entity_name IS NOT DISTINCT FROM OLD.issuing_entity_name
      AND NEW.issuing_entity_type = OLD.issuing_entity_type
      AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
      AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
      AND NEW.status = OLD.status
      AND NEW.created_at = OLD.created_at;
    IF NEW.worker_id <> OLD.worker_id THEN
      RAISE EXCEPTION 'CREDENTIAL_MANAGER_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_evidence_only THEN
    RETURN NEW;
  END IF;
  IF v_owner IS NOT NULL AND v_actor IS NOT NULL AND v_owner = v_actor THEN
    RAISE EXCEPTION 'CREDENTIAL_SELF_MANAGEMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT app_is_org_manager() THEN
    RAISE EXCEPTION 'CREDENTIAL_MANAGER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.app_credential_write_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS credentials_write_guard ON credentials;
CREATE TRIGGER credentials_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON credentials
  FOR EACH ROW EXECUTE FUNCTION public.app_credential_write_guard();

-- ---------------------------------------------------------------- B2: nadie se aprueba a sí misma
CREATE OR REPLACE FUNCTION public.app_credential_self_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_owner uuid;
BEGIN
  IF current_user <> 'app_runtime' AND session_user <> 'app_runtime' THEN
    RETURN NEW;
  END IF;
  -- Returning a review to pending (the owner's new evidence) is not a decision.
  IF NEW.review_status::text NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;
  SELECT public.app_credential_owner_user(c.worker_id) INTO v_owner
    FROM credentials c WHERE c.id = NEW.credential_id;
  IF v_owner IS NOT NULL AND (v_owner = NEW.reviewed_by_user_id OR v_owner = v_actor) THEN
    RAISE EXCEPTION 'CREDENTIAL_SELF_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_credential_self_review_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS organization_credential_reviews_self_guard ON organization_credential_reviews;
CREATE TRIGGER organization_credential_reviews_self_guard
  BEFORE INSERT OR UPDATE ON organization_credential_reviews
  FOR EACH ROW EXECUTE FUNCTION public.app_credential_self_review_guard();
DROP TRIGGER IF EXISTS organization_document_version_reviews_self_guard ON organization_document_version_reviews;
CREATE TRIGGER organization_document_version_reviews_self_guard
  BEFORE INSERT ON organization_document_version_reviews
  FOR EACH ROW EXECUTE FUNCTION public.app_credential_self_review_guard();

-- 163: interruptor de la modalidad «Cuidador independiente» en ETNARA Central (24-nov-2026).
-- Preparación; la modalidad sigue APAGADA.
--
-- Qué hace:
--   * app_platform_set_modality(code, enabled, reason): única vía para cambiar platform_modalities desde la
--     aplicación. Exige administración de plataforma verificada (app_is_superadmin(): bandera de contexto
--     MÁS fila vigente en platform_admins), un motivo (10–1000 caracteres) y deja un evento con el valor
--     anterior, el nuevo, el motivo, la persona y la fecha. app_runtime sigue sin poder escribir la tabla.
--   * platform_modality_events: registro solo de añadir (nadie lo cambia, borra ni vacía).
--   * app_platform_list_modalities(): lectura para Central (solo administración de plataforma).
--
-- Qué NO hace:
--   * No enciende nada: el valor actual (apagado) no se toca.
--   * Encender exige además, en el servidor, INDEPENDENT_MODALITY_ACTIVATION_ALLOWED=on (ausente = no):
--     sin esa variable, que solo se cambia con autorización expresa, Central puede apagar pero no encender.
--   * El interruptor solo gobierna el REGISTRO de nuevas organizaciones independientes (guarda 160 en
--     organizations y la creación en Central). Apagarlo no toca a los proveedores ya registrados: sus
--     organizaciones, membresías, documentos, turnos e informes siguen funcionando.
-- Idempotente. Reversión: ops/163_platform_modality_switch_central.rollback.sql (conserva los eventos).

ALTER TABLE platform_modalities ADD COLUMN IF NOT EXISTS updated_by_user_id uuid NULL;

CREATE TABLE IF NOT EXISTS platform_modality_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  modality_code     text NOT NULL,
  previous_enabled  boolean NOT NULL,
  new_enabled       boolean NOT NULL,
  reason            text NOT NULL,
  actor_user_id     uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_modality_events_code_time ON platform_modality_events (modality_code, occurred_at DESC);
ALTER TABLE platform_modality_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_modality_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_modality_events FROM PUBLIC;
REVOKE ALL ON platform_modality_events FROM app_runtime;
GRANT SELECT ON platform_modality_events TO app_runtime;
DROP POLICY IF EXISTS platform_modality_events_platform_read ON platform_modality_events;
CREATE POLICY platform_modality_events_platform_read ON platform_modality_events
  FOR SELECT USING (app_is_superadmin());

CREATE OR REPLACE FUNCTION public.app_platform_modality_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'MODALITY_AUDIT_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_modality_events_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS platform_modality_events_no_update ON platform_modality_events;
CREATE TRIGGER platform_modality_events_no_update
  BEFORE UPDATE OR DELETE ON platform_modality_events
  FOR EACH ROW EXECUTE FUNCTION public.app_platform_modality_events_immutable();
DROP TRIGGER IF EXISTS platform_modality_events_no_truncate ON platform_modality_events;
CREATE TRIGGER platform_modality_events_no_truncate
  BEFORE TRUNCATE ON platform_modality_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.app_platform_modality_events_immutable();

CREATE OR REPLACE FUNCTION public.app_platform_set_modality(p_code text, p_enabled boolean, p_reason text)
RETURNS TABLE (code text, enabled boolean, updated_at timestamptz, changed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_prev boolean;
BEGIN
  IF v_actor IS NULL OR NOT public.app_is_superadmin() THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'MODALITY_STATE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) < 10 OR char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'MODALITY_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT pm.enabled INTO v_prev FROM platform_modalities pm WHERE pm.code = p_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODALITY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_prev = p_enabled THEN
    RETURN QUERY SELECT pm.code, pm.enabled, pm.updated_at, false FROM platform_modalities pm WHERE pm.code = p_code;
    RETURN;
  END IF;

  UPDATE platform_modalities pm
     SET enabled = p_enabled, updated_at = now(), updated_by_user_id = v_actor
   WHERE pm.code = p_code;
  INSERT INTO platform_modality_events (modality_code, previous_enabled, new_enabled, reason, actor_user_id)
  VALUES (p_code, v_prev, p_enabled, v_reason, v_actor);

  RETURN QUERY SELECT pm.code, pm.enabled, pm.updated_at, true FROM platform_modalities pm WHERE pm.code = p_code;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_set_modality(text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_set_modality(text, boolean, text) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_platform_list_modalities()
RETURNS TABLE (code text, enabled boolean, updated_at timestamptz, updated_by_user_id uuid, registered_organizations integer)
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
    SELECT pm.code, pm.enabled, pm.updated_at, pm.updated_by_user_id,
           (SELECT count(*)::int FROM organizations o
             WHERE pm.code = 'INDEPENDENT_PROVIDER' AND o.organization_type = 'INDEPENDENT_PROVIDER')
      FROM platform_modalities pm
     ORDER BY pm.code;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_list_modalities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_list_modalities() TO app_runtime;

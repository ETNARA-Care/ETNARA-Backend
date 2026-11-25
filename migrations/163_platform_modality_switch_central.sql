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
--   * SEGUNDO CANDADO EN LA BASE DE DATOS (decisión de Rafa, 24-nov-2026): ninguna operación puede pasar una modalidad
--     de apagada a encendida —ni Central, ni el propietario de la base, ni una sentencia manual— sin una AUTORIZACIÓN
--     DE ACTIVACIÓN vigente: de un solo uso, con fecha de vencimiento (máximo 24 h), nombre de quien autoriza y motivo.
--     Solo la crea una operación (app_ops_authorize_modality_activation, sin permiso para app_runtime). La consume el
--     propio encendido, en la misma transacción. Apagar nunca necesita autorización.
--     Encender exige así TRES llaves: autorización en la base + variable del servidor + administración de Central.
--
-- Qué NO hace:
--   * No enciende nada: el valor actual (apagado) no se toca.
--   * Encender exige además, en el servidor, INDEPENDENT_MODALITY_ACTIVATION_ALLOWED=on (ausente = no):
--     sin esa variable, que solo se cambia con autorización expresa, Central puede apagar pero no encender.
--   * El interruptor solo gobierna el REGISTRO de nuevas organizaciones independientes (guarda 160 en
--     organizations y la creación en Central). Apagarlo no toca a los proveedores ya registrados: sus
--     organizaciones, membresías, documentos, turnos e informes siguen funcionando.
-- Idempotente. Reversión: ops/163_platform_modality_switch_central.rollback.sql (conserva los eventos y las autorizaciones).

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

-- ---------------------------------------------------------------------------------------------------------------
-- Segundo candado: autorizaciones de activación (de un solo uso, con vencimiento) y guarda en platform_modalities.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_modality_activation_authorizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modality_code        text NOT NULL,
  authorized_by        text NOT NULL CHECK (char_length(btrim(authorized_by)) BETWEEN 2 AND 200),
  reason               text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_role      text NOT NULL DEFAULT session_user,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz NULL,
  consumed_by_user_id  uuid NULL,
  revoked_at           timestamptz NULL,
  revoked_reason       text NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_modality_activation_one_open
  ON platform_modality_activation_authorizations (modality_code)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
ALTER TABLE platform_modality_activation_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_modality_activation_authorizations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_modality_activation_authorizations FROM PUBLIC;
REVOKE ALL ON platform_modality_activation_authorizations FROM app_runtime;
-- Sin políticas: la aplicación no la lee ni la escribe. Solo las funciones SECURITY DEFINER de abajo.
-- (FORCE RLS sin políticas también cierra el acceso directo del propietario; las funciones lo usan como definidor.)
DROP POLICY IF EXISTS platform_modality_activation_definer ON platform_modality_activation_authorizations;
CREATE POLICY platform_modality_activation_definer ON platform_modality_activation_authorizations
  FOR ALL USING (current_user <> 'app_runtime') WITH CHECK (current_user <> 'app_runtime');

-- Nadie borra ni vacía una autorización (registro). Solo se permite marcarla consumida o revocada, una vez.
CREATE OR REPLACE FUNCTION public.app_platform_modality_authorization_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'MODALITY_AUTHORIZATION_APPEND_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NEW.id <> OLD.id OR NEW.modality_code <> OLD.modality_code OR NEW.authorized_by <> OLD.authorized_by
     OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_by_role <> OLD.created_by_role
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'MODALITY_AUTHORIZATION_APPEND_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_modality_authorization_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS platform_modality_authorization_guard ON platform_modality_activation_authorizations;
CREATE TRIGGER platform_modality_authorization_guard
  BEFORE UPDATE OR DELETE ON platform_modality_activation_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.app_platform_modality_authorization_guard();
DROP TRIGGER IF EXISTS platform_modality_authorization_no_truncate ON platform_modality_activation_authorizations;
CREATE TRIGGER platform_modality_authorization_no_truncate
  BEFORE TRUNCATE ON platform_modality_activation_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.app_platform_modality_authorization_guard();

-- OPERACIÓN (nunca la aplicación): crea la autorización de un solo uso. Se ejecuta solo con la autorización expresa de Rafa.
CREATE OR REPLACE FUNCTION public.app_ops_authorize_modality_activation(
  p_code text, p_authorized_by text, p_reason text, p_valid_minutes integer DEFAULT 60
)
RETURNS TABLE (authorization_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid; v_exp timestamptz;
BEGIN
  IF session_user = 'app_runtime' THEN
    RAISE EXCEPTION 'MODALITY_AUTHORIZATION_OPS_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_modalities WHERE code = p_code) THEN
    RAISE EXCEPTION 'MODALITY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_valid_minutes IS NULL OR p_valid_minutes < 1 OR p_valid_minutes > 1440 THEN
    RAISE EXCEPTION 'MODALITY_AUTHORIZATION_WINDOW_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Una autorización abierta caducada se cierra como revocada antes de crear otra.
  UPDATE platform_modality_activation_authorizations a
     SET revoked_at = now(), revoked_reason = 'vencida'
   WHERE a.modality_code = p_code AND a.consumed_at IS NULL AND a.revoked_at IS NULL AND a.expires_at <= now();
  INSERT INTO platform_modality_activation_authorizations (modality_code, authorized_by, reason, expires_at)
  VALUES (p_code, btrim(p_authorized_by), btrim(p_reason), now() + make_interval(mins => p_valid_minutes))
  RETURNING id, platform_modality_activation_authorizations.expires_at INTO v_id, v_exp;
  RETURN QUERY SELECT v_id, v_exp;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'MODALITY_AUTHORIZATION_ALREADY_OPEN' USING ERRCODE = '23505';
END;
$$;
REVOKE ALL ON FUNCTION public.app_ops_authorize_modality_activation(text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_ops_authorize_modality_activation(text, text, text, integer) FROM app_runtime;

-- OPERACIÓN: retirar una autorización abierta sin usarla.
CREATE OR REPLACE FUNCTION public.app_ops_revoke_modality_activation(p_code text, p_reason text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_n integer;
BEGIN
  IF session_user = 'app_runtime' THEN
    RAISE EXCEPTION 'MODALITY_AUTHORIZATION_OPS_ONLY' USING ERRCODE = '42501';
  END IF;
  UPDATE platform_modality_activation_authorizations a
     SET revoked_at = now(), revoked_reason = left(coalesce(btrim(p_reason), 'retirada'), 1000)
   WHERE a.modality_code = p_code AND a.consumed_at IS NULL AND a.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.app_ops_revoke_modality_activation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_ops_revoke_modality_activation(text, text) FROM app_runtime;

-- El candado: pasar de apagada a encendida (o insertar encendida) consume una autorización vigente; si no hay, se rechaza.
-- Se aplica a TODOS los roles, incluido el propietario. Apagar no se toca.
CREATE OR REPLACE FUNCTION public.app_platform_modality_activation_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_auth uuid;
BEGIN
  IF NEW.enabled IS TRUE AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM TRUE) THEN
    SELECT a.id INTO v_auth
      FROM platform_modality_activation_authorizations a
     WHERE a.modality_code = NEW.code AND a.consumed_at IS NULL AND a.revoked_at IS NULL AND a.expires_at > now()
     ORDER BY a.created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF v_auth IS NULL THEN
      RAISE EXCEPTION 'MODALITY_ACTIVATION_LOCKED' USING ERRCODE = '42501';
    END IF;
    UPDATE platform_modality_activation_authorizations
       SET consumed_at = now(), consumed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
     WHERE id = v_auth;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_modality_activation_lock() FROM PUBLIC;
DROP TRIGGER IF EXISTS platform_modalities_activation_lock ON platform_modalities;
CREATE TRIGGER platform_modalities_activation_lock
  BEFORE INSERT OR UPDATE OF enabled ON platform_modalities
  FOR EACH ROW EXECUTE FUNCTION public.app_platform_modality_activation_lock();

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

DROP FUNCTION IF EXISTS public.app_platform_list_modalities();
CREATE OR REPLACE FUNCTION public.app_platform_list_modalities()
RETURNS TABLE (code text, enabled boolean, updated_at timestamptz, updated_by_user_id uuid, registered_organizations integer,
               activation_unlocked boolean, activation_unlocked_until timestamptz)
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
             WHERE pm.code = 'INDEPENDENT_PROVIDER' AND o.organization_type = 'INDEPENDENT_PROVIDER'),
           (a.id IS NOT NULL), a.expires_at
      FROM platform_modalities pm
      LEFT JOIN LATERAL (
        SELECT x.id, x.expires_at FROM platform_modality_activation_authorizations x
         WHERE x.modality_code = pm.code AND x.consumed_at IS NULL AND x.revoked_at IS NULL AND x.expires_at > now()
         ORDER BY x.created_at DESC LIMIT 1
      ) a ON true
     ORDER BY pm.code;
END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_list_modalities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_list_modalities() TO app_runtime;

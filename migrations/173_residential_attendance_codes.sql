-- 173 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F4 (1 de 3): códigos semanales de asistencia (QR y 6 dígitos).
-- 26-nov-2026. Fuente oficial: plan de implementación definitivo (D4; §5 «Ciclo semanal» y «Protección del QR»; §7).
--
-- Depende de la 171 (establecimientos con habitación técnica). No modifica la tabla shifts. Nada se enciende: las rutas
-- van detrás del interruptor HOGAR_PONCHES (apagado por defecto).
--
-- Ni el token del QR ni el código de 6 dígitos se guardan: el servidor los deriva con HMAC-SHA256 de un secreto que NO
-- está en la base (ATTENDANCE_CODE_SECRET, con identificador de clave). Aquí solo hay metadatos:
--   * attendance_codes: una fila por establecimiento, semana (lunes, hora de Puerto Rico) y versión. Rige del lunes 00:00
--     AST al lunes siguiente; disponible 72 h antes (viernes 00:00 AST); transición de 0 a 12 h solo para cerrar
--     sesiones abiertas con él. Revocar es inmediato, prevalece sobre la transición y crea la versión siguiente.
--   * attendance_code_events: historial (generado, revocado, descargado). Solo anexos.
--   * attendance_code_attempts: cada intento de ponchar con código (para el límite de intentos). Solo anexos.
-- Reversión: ops/173_residential_attendance_codes.rollback.sql.

-- 1. Tablas ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_codes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  location_id           uuid NOT NULL,
  week_start            date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  version               integer NOT NULL CHECK (version >= 1),
  key_id                text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  available_from        timestamptz NOT NULL,
  valid_from            timestamptz NOT NULL,
  valid_until           timestamptz NOT NULL,
  transition_hours      smallint NOT NULL DEFAULT 8 CHECK (transition_hours BETWEEN 0 AND 12),
  revoked_at            timestamptz NULL,
  revoked_by_user_id    uuid NULL REFERENCES users (id),
  revoke_reason         text NULL CHECK (revoke_reason IS NULL OR char_length(btrim(revoke_reason)) BETWEEN 3 AND 300),
  available_notified_at timestamptz NULL,
  created_by_user_id    uuid NULL REFERENCES users (id),          -- NULL: lo creó el trabajo programado
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (location_id, week_start, version),
  CHECK (valid_until > valid_from AND available_from <= valid_from),
  CHECK ((revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS attendance_codes_location_week_idx ON attendance_codes (location_id, week_start DESC, version DESC);

CREATE TABLE IF NOT EXISTS attendance_code_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id     uuid NOT NULL,
  code_id         uuid NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('generated', 'revoked', 'downloaded')),
  actor_user_id   uuid NULL REFERENCES users (id),
  reason          text NULL CHECK (reason IS NULL OR char_length(reason) <= 300),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (code_id, organization_id) REFERENCES attendance_codes (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS attendance_code_events_location_idx ON attendance_code_events (location_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS attendance_code_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id     uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  method          text NOT NULL CHECK (method IN ('qr', 'pin')),
  outcome         text NOT NULL CHECK (outcome IN ('current', 'transition', 'invalid', 'expired', 'revoked', 'other_location', 'blocked')),
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS attendance_code_attempts_user_idx ON attendance_code_attempts (user_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS attendance_code_attempts_location_idx ON attendance_code_attempts (location_id, attempted_at DESC);

-- 2. Guardas -------------------------------------------------------------------------------------------------------
-- Solo hogares y solo establecimientos de hogar (con habitación técnica) de la organización.
CREATE OR REPLACE FUNCTION public.app_attendance_location_guard(p_organization_id uuid, p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME') THEN
    RAISE EXCEPTION 'MODALITY_NOT_AVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations l JOIN establishment_technical_rooms t ON t.location_id = l.id
                 WHERE l.id = p_location_id AND l.organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_location_guard(uuid, uuid) FROM PUBLIC;

-- Códigos: la ventana se deriva SIEMPRE de la semana (no la decide quien escribe); solo cambian la revocación, el aviso
-- de disponibilidad y la transición mientras el código no haya vencido.
CREATE OR REPLACE FUNCTION public.app_attendance_code_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
    -- Versiones consecutivas por establecimiento y semana (la revocación crea la siguiente).
    IF NEW.version <> COALESCE((SELECT max(c.version) FROM attendance_codes c WHERE c.location_id = NEW.location_id AND c.week_start = NEW.week_start), 0) + 1 THEN
      RAISE EXCEPTION 'ATTENDANCE_CODE_VERSION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    NEW.valid_from := (NEW.week_start::timestamp AT TIME ZONE 'America/Puerto_Rico');
    NEW.valid_until := ((NEW.week_start + 7)::timestamp AT TIME ZONE 'America/Puerto_Rico');
    NEW.available_from := NEW.valid_from - interval '72 hours';
    NEW.revoked_at := NULL; NEW.revoked_by_user_id := NULL; NEW.revoke_reason := NULL; NEW.available_notified_at := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.week_start IS DISTINCT FROM OLD.week_start
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.available_from IS DISTINCT FROM OLD.available_from OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  -- Una revocación no se deshace.
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id
                                     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.available_notified_at IS NOT NULL AND NEW.available_notified_at IS DISTINCT FROM OLD.available_notified_at THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  -- La transición solo se ajusta mientras el código (con su transición) sigue en uso.
  IF NEW.transition_hours IS DISTINCT FROM OLD.transition_hours
     AND OLD.valid_until + make_interval(hours => OLD.transition_hours) <= now() THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_code_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_codes_guard ON attendance_codes;
CREATE TRIGGER attendance_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_codes
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_code_guard();

-- Eventos e intentos: del mismo establecimiento y organización; solo anexos.
CREATE OR REPLACE FUNCTION public.app_attendance_code_child_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
  -- Ramas separadas: cada tabla tiene sus propias columnas (PL/pgSQL resuelve NEW.<campo> al evaluar la expresión).
  IF TG_TABLE_NAME = 'attendance_code_events' THEN
    IF NOT EXISTS (SELECT 1 FROM attendance_codes c WHERE c.id = NEW.code_id AND c.location_id = NEW.location_id) THEN
      RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    NEW.occurred_at := now();
  ELSE
    NEW.attempted_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_code_child_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_code_events_guard ON attendance_code_events;
CREATE TRIGGER attendance_code_events_guard BEFORE INSERT ON attendance_code_events
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_code_child_guard();
DROP TRIGGER IF EXISTS attendance_code_attempts_guard ON attendance_code_attempts;
CREATE TRIGGER attendance_code_attempts_guard BEFORE INSERT ON attendance_code_attempts
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_code_child_guard();
DROP TRIGGER IF EXISTS attendance_code_events_append_only ON attendance_code_events;
CREATE TRIGGER attendance_code_events_append_only BEFORE UPDATE OR DELETE ON attendance_code_events
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();
DROP TRIGGER IF EXISTS attendance_code_attempts_append_only ON attendance_code_attempts;
CREATE TRIGGER attendance_code_attempts_append_only BEFORE UPDATE OR DELETE ON attendance_code_attempts
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- 3. Funciones para el personal (SECURITY DEFINER; solo metadatos, nunca un secreto) ---------------------------------
-- Quien poncha no lee attendance_codes (RLS solo administración). Para validar su código, el servidor pide la ventana
-- vigente del establecimiento: la versión vigente de la semana del instante y, si existe, la de la semana anterior en
-- transición. Solo responde a miembros activos de la organización de la sesión.
CREATE OR REPLACE FUNCTION public.app_attendance_code_window(p_location_id uuid, p_at timestamptz)
RETURNS TABLE (code_id uuid, week_start date, version integer, key_id text, role text, valid_from timestamptz, valid_until timestamptz, transition_until timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_week date := (date_trunc('week', p_at AT TIME ZONE 'America/Puerto_Rico'))::date;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS (
       SELECT 1 FROM organization_memberships m WHERE m.organization_id = v_org AND m.user_id = v_user AND m.status = 'active') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = p_location_id AND l.organization_id = v_org) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c.id, c.week_start, c.version, c.key_id, 'current'::text, c.valid_from, c.valid_until,
           c.valid_until + make_interval(hours => c.transition_hours)
    FROM attendance_codes c
    WHERE c.location_id = p_location_id AND c.organization_id = v_org AND c.week_start = v_week AND c.revoked_at IS NULL
    ORDER BY c.version DESC LIMIT 1;
  -- Semana anterior en transición: su última versión, si no está revocada (la revocación prevalece) y la transición sigue.
  RETURN QUERY
    SELECT c.id, c.week_start, c.version, c.key_id, 'transition'::text, c.valid_from, c.valid_until,
           c.valid_until + make_interval(hours => c.transition_hours)
    FROM attendance_codes c
    WHERE c.location_id = p_location_id AND c.organization_id = v_org AND c.week_start = v_week - 7
      AND c.version = (SELECT max(x.version) FROM attendance_codes x WHERE x.location_id = c.location_id AND x.week_start = c.week_start)
      AND c.revoked_at IS NULL
      AND p_at < c.valid_until + make_interval(hours => c.transition_hours);
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_code_window(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_code_window(uuid, timestamptz) TO app_runtime;

-- Intentos fallidos en los últimos 15 minutos: los de quien poncha y los del establecimiento (límite y bloqueo).
CREATE OR REPLACE FUNCTION public.app_attendance_failed_attempts(p_location_id uuid)
RETURNS TABLE (user_failed integer, location_failed integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS (
       SELECT 1 FROM organization_memberships m WHERE m.organization_id = v_org AND m.user_id = v_user AND m.status = 'active') THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM attendance_code_attempts a WHERE a.user_id = v_user AND a.organization_id = v_org
        AND a.attempted_at > now() - interval '15 minutes' AND a.outcome NOT IN ('current', 'transition')),
    (SELECT count(*)::integer FROM attendance_code_attempts a WHERE a.location_id = p_location_id AND a.organization_id = v_org
        AND a.attempted_at > now() - interval '15 minutes' AND a.outcome NOT IN ('current', 'transition'));
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_failed_attempts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_failed_attempts(uuid) TO app_runtime;

-- 4. Trabajo programado: crea, idempotente, los códigos que falten (semana del instante y la siguiente) de cada
-- establecimiento de hogar con HOGAR_PONCHES encendido. La activación depende de la hora, no de que el trabajo corra.
CREATE OR REPLACE FUNCTION public.app_attendance_ensure_codes(p_now timestamptz, p_key_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_week date := (date_trunc('week', p_now AT TIME ZONE 'America/Puerto_Rico'))::date;
  v_created integer := 0;
  r record;
  w date;
  v_id uuid;
BEGIN
  IF p_key_id IS NULL OR p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE = 'P0001';
  END IF;
  FOR r IN
    SELECT l.id AS location_id, l.organization_id
    FROM locations l
    JOIN establishment_technical_rooms t ON t.location_id = l.id
    JOIN organizations o ON o.id = l.organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME'
    WHERE l.archived_at IS NULL AND public.app_org_feature_enabled(l.organization_id, 'HOGAR_PONCHES')
  LOOP
    FOREACH w IN ARRAY ARRAY[v_week, v_week + 7] LOOP
      IF NOT EXISTS (SELECT 1 FROM attendance_codes c WHERE c.location_id = r.location_id AND c.week_start = w) THEN
        INSERT INTO attendance_codes (organization_id, location_id, week_start, version, key_id, available_from, valid_from, valid_until)
        VALUES (r.organization_id, r.location_id, w, 1, p_key_id, p_now, p_now, p_now + interval '1 second')
        ON CONFLICT (location_id, week_start, version) DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
          INSERT INTO attendance_code_events (organization_id, location_id, code_id, event_type) VALUES (r.organization_id, r.location_id, v_id, 'generated');
          v_created := v_created + 1;
          v_id := NULL;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_ensure_codes(timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_ensure_codes(timestamptz, text) TO app_runtime;

-- Aviso de disponibilidad: una sola vez por código, a la administración del hogar, cuando llega su «disponible desde».
-- Texto general en el portal («Código de asistencia disponible para imprimir»); sin códigos ni datos personales.
CREATE OR REPLACE FUNCTION public.app_attendance_notify_available(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer := 0;
  c record;
BEGIN
  FOR c IN
    SELECT x.id, x.organization_id FROM attendance_codes x
    WHERE x.available_notified_at IS NULL AND x.revoked_at IS NULL AND x.available_from <= p_now AND x.valid_until > p_now
      AND public.app_org_feature_enabled(x.organization_id, 'HOGAR_PONCHES')
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
    SELECT DISTINCT m.user_id, c.organization_id, 'ATTENDANCE_CODE_AVAILABLE', 'attendance_code', c.id, 'in_app', 'sent', now()
    FROM organization_memberships m
    JOIN user_roles ur ON ur.organization_membership_id = m.id
    JOIN roles ro ON ro.id = ur.role_id AND ro.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
    WHERE m.organization_id = c.organization_id AND m.status = 'active';
    UPDATE attendance_codes SET available_notified_at = now() WHERE id = c.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_notify_available(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_notify_available(timestamptz) TO app_runtime;

-- 5. RLS y permisos ------------------------------------------------------------------------------------------------
ALTER TABLE attendance_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_code_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_code_attempts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_codes','attendance_code_events','attendance_code_attempts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_read', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin())$p$,
      t || '_manager_read', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['attendance_codes','attendance_code_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_insert', t);
  END LOOP;
END;
$$;
DROP POLICY IF EXISTS attendance_codes_manager_update ON attendance_codes;
CREATE POLICY attendance_codes_manager_update ON attendance_codes FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id));
-- Intentos: cada persona registra SOLO los suyos, en un hogar del que es miembro activo.
DROP POLICY IF EXISTS attendance_code_attempts_self_insert ON attendance_code_attempts;
CREATE POLICY attendance_code_attempts_self_insert ON attendance_code_attempts FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_org_is_residential(organization_id)
  AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = attendance_code_attempts.organization_id
              AND m.user_id = attendance_code_attempts.user_id AND m.status = 'active'));

GRANT SELECT, INSERT, UPDATE ON attendance_codes TO app_runtime;
GRANT SELECT, INSERT ON attendance_code_events, attendance_code_attempts TO app_runtime;

-- 6. Aviso de disponibilidad: lo inserta app_attendance_notify_available (dueño); app_runtime no inserta este tipo.

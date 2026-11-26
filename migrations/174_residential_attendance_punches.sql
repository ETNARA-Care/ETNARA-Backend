-- 174 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F4 (2 de 3): ponches y consentimiento de geolocalización laboral.
-- 26-nov-2026. Fuente oficial: plan de implementación definitivo (D3; D4; §5 «Declaración frente a ponche validado»,
-- «Casos límite» y «Geocerca»; §7).
--
-- Depende de la 171 y la 173. No modifica la tabla shifts. Nada se enciende (HOGAR_PONCHES apagado por defecto).
--
--   * attendance_punches: cada intento de ponchar, siempre con la hora del servidor; sin conexión, además la hora
--     declarada por el dispositivo. Cuatro dimensiones de estado: ubicación, origen, código y validación inicial.
--     Solo anexos: el original nunca cambia (la revisión de la 175 añade decisiones, no edita).
--     PRIVACIDAD: no hay columnas de coordenadas. Se guarda solo el estado de ubicación, la distancia redondeada a 10 m
--     y la precisión. La ubicación solo se lee al ponchar (sin rastreo).
--   * attendance_geo_consents: consentimiento propio, versionado y revocable. Sin consentimiento vigente no se usa la
--     ubicación y el ponche queda con «ubicación no disponible»: nunca se impide ponchar.
--
-- Reglas en la base (también contra app_runtime directo):
--   * solo hogares, solo establecimientos de hogar y solo turnos del establecimiento (habitación técnica);
--   * quien poncha lo hace para sí, con una asignación aceptada en ese turno; los ponches manuales son de la
--     administración, con motivo, nunca para sí misma;
--   * «validado» exige en línea + código vigente (o en transición, solo para salir) + dentro del perímetro + sin marcas;
--     sin conexión nunca se valida automáticamente; un ponche manual queda «justificado».
-- Reversión: ops/174_residential_attendance_punches.rollback.sql.

-- 1. Consentimiento de geolocalización laboral ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_geo_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  consent_version text NOT NULL CHECK (consent_version ~ '^[a-z0-9.-]{1,32}$'),
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz NULL,
  CHECK (revoked_at IS NULL OR revoked_at >= accepted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_geo_consents_active_uidx
  ON attendance_geo_consents (organization_id, user_id) WHERE revoked_at IS NULL;

-- 2. Ponches -------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_punches (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL,
  location_id                       uuid NOT NULL,
  shift_id                          uuid NOT NULL,
  organization_worker_membership_id uuid NOT NULL,
  user_id                           uuid NOT NULL REFERENCES users (id),
  punch_type                        text NOT NULL CHECK (punch_type IN ('in', 'out', 'break_start', 'break_end', 'meal_start', 'meal_end')),
  client_event_id                   uuid NULL,
  origin                            text NOT NULL CHECK (origin IN ('online', 'offline', 'manual')),
  declared_at                       timestamptz NULL,          -- hora del dispositivo (sin conexión) o la indicada en un ponche manual
  server_received_at                timestamptz NOT NULL DEFAULT now(),
  effective_at                      timestamptz NOT NULL,      -- en línea: la del servidor; sin conexión / manual: la declarada
  code_method                       text NOT NULL CHECK (code_method IN ('qr', 'pin', 'none')),
  code_status                       text NOT NULL CHECK (code_status IN ('current', 'transition', 'invalid', 'none')),
  code_id                           uuid NULL,
  location_status                   text NOT NULL CHECK (location_status IN ('inside', 'outside', 'low_accuracy', 'unavailable')),
  distance_m                        integer NULL CHECK (distance_m IS NULL OR (distance_m BETWEEN 0 AND 100000 AND distance_m % 10 = 0)),
  accuracy_m                        integer NULL CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
  initial_validation                text NOT NULL CHECK (initial_validation IN ('validated', 'pending_review', 'justified')),
  flags                             text[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY[
                                      'declared_in_future', 'before_code', 'outside_shift_window', 'clock_skew', 'impossible_order',
                                      'received_after_72h', 'code_invalid', 'transition_not_for_entry', 'no_consent', 'no_geofence_center',
                                      'duplicate_open_session']::text[]),
  session_in_punch_id               uuid NULL REFERENCES attendance_punches (id),
  manual_reason                     text NULL CHECK (manual_reason IS NULL OR char_length(btrim(manual_reason)) BETWEEN 3 AND 300),
  created_by_user_id                uuid NOT NULL REFERENCES users (id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (code_id, organization_id) REFERENCES attendance_codes (id, organization_id),
  -- Origen manual: de la administración, con motivo, sin código ni ubicación, «justificado».
  CHECK (origin <> 'manual' OR (manual_reason IS NOT NULL AND initial_validation = 'justified' AND code_method = 'none'
                               AND code_status = 'none' AND location_status = 'unavailable' AND distance_m IS NULL
                               AND client_event_id IS NULL AND declared_at IS NOT NULL)),
  CHECK (origin = 'manual' OR (manual_reason IS NULL AND initial_validation <> 'justified' AND client_event_id IS NOT NULL)),
  -- Sin conexión: nunca validado automáticamente, siempre con la hora declarada.
  CHECK (origin <> 'offline' OR (initial_validation = 'pending_review' AND declared_at IS NOT NULL)),
  -- Validado solo en línea, con código vigente o en transición, dentro del perímetro y sin marcas.
  CHECK (initial_validation <> 'validated' OR (origin = 'online' AND code_status IN ('current', 'transition')
                                               AND location_status = 'inside' AND cardinality(flags) = 0)),
  -- El código en transición solo cierra (salida); nunca abre una entrada.
  CHECK (code_status <> 'transition' OR punch_type = 'out'),
  CHECK ((code_status IN ('current', 'transition')) = (code_id IS NOT NULL)),
  CHECK ((code_method = 'none') = (code_status = 'none')),
  CHECK (punch_type = 'in' OR origin = 'manual' OR session_in_punch_id IS NOT NULL OR 'impossible_order' = ANY (flags)),
  CHECK (punch_type <> 'in' OR session_in_punch_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_punches_client_event_uidx
  ON attendance_punches (organization_id, user_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_punches_shift_user_idx ON attendance_punches (shift_id, user_id, effective_at);
CREATE INDEX IF NOT EXISTS attendance_punches_location_idx ON attendance_punches (location_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS attendance_punches_user_idx ON attendance_punches (user_id, effective_at DESC);

-- 3. Guardas -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_attendance_punch_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_tech uuid;
  v_shift record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
  NEW.server_received_at := now();
  NEW.created_at := now();
  -- Turno del establecimiento: su habitación técnica, de la misma organización y no cancelado.
  SELECT t.room_id INTO v_tech FROM establishment_technical_rooms t WHERE t.location_id = NEW.location_id;
  SELECT s.id, s.status::text AS status INTO v_shift FROM shifts s
   WHERE s.id = NEW.shift_id AND s.organization_id = NEW.organization_id AND s.room_id = v_tech;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTENDANCE_SHIFT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- La membresía es de la persona del ponche.
  IF NOT EXISTS (SELECT 1 FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
                 WHERE m.id = NEW.organization_worker_membership_id AND m.organization_id = NEW.organization_id AND w.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.origin = 'manual' THEN
    -- Administración del hogar, nunca para sí misma; la hora es la indicada.
    IF v_user IS NULL OR NEW.created_by_user_id IS DISTINCT FROM v_user OR v_user = NEW.user_id OR NOT public.app_is_org_manager() THEN
      RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
    END IF;
    NEW.effective_at := NEW.declared_at;
  ELSE
    -- Para sí, con una asignación aceptada y una membresía activa, en un turno no cancelado.
    IF v_user IS NULL OR NEW.user_id IS DISTINCT FROM v_user OR NEW.created_by_user_id IS DISTINCT FROM v_user
       OR v_shift.status = 'cancelled'
       OR NOT EXISTS (SELECT 1 FROM assignments a JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
                      WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                        AND a.organization_worker_membership_id = NEW.organization_worker_membership_id
                        AND a.response_status = 'accepted' AND m.status = 'active') THEN
      RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
    END IF;
    NEW.effective_at := CASE WHEN NEW.origin = 'offline' THEN NEW.declared_at ELSE now() END;
  END IF;
  -- El código pertenece al mismo establecimiento.
  IF NEW.code_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attendance_codes c WHERE c.id = NEW.code_id AND c.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'ATTENDANCE_CODE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- La sesión a la que pertenece es una entrada de la misma persona y el mismo turno.
  IF NEW.session_in_punch_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM attendance_punches p WHERE p.id = NEW.session_in_punch_id AND p.punch_type = 'in'
         AND p.user_id = NEW.user_id AND p.shift_id = NEW.shift_id) THEN
    RAISE EXCEPTION 'ATTENDANCE_SESSION_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_punch_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_punches_guard ON attendance_punches;
CREATE TRIGGER attendance_punches_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_punches
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_punch_guard();

-- Consentimientos: cada persona el suyo; solo se puede revocar (una vez), nunca editar ni borrar.
CREATE OR REPLACE FUNCTION public.app_attendance_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME') THEN
    RAISE EXCEPTION 'MODALITY_NOT_AVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.accepted_at := now();
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.consent_version IS DISTINCT FROM OLD.consent_version OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_consent_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_geo_consents_guard ON attendance_geo_consents;
CREATE TRIGGER attendance_geo_consents_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_geo_consents
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_consent_guard();

-- Turnos propios para ponchar: los turnos del establecimiento (habitación técnica) en los que la persona de la sesión
-- tiene una asignación aceptada con una membresía activa. Incluye el centro y el radio de la geocerca SOLO para que el
-- servidor calcule el estado al ponchar (el servidor nunca los envía al teléfono). Sirve también para sincronizar un
-- ponche sin conexión después del fin del turno (la RLS de shifts ya no lo mostraría).
CREATE OR REPLACE FUNCTION public.app_attendance_my_shifts(p_from timestamptz, p_to timestamptz, p_shift_id uuid DEFAULT NULL)
RETURNS TABLE (shift_id uuid, location_id uuid, location_name text, membership_id uuid, scheduled_start timestamptz, scheduled_end timestamptz,
               shift_status text, geofence_latitude numeric, geofence_longitude numeric, geofence_radius_m integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, l.id, l.name, a.organization_worker_membership_id, s.scheduled_start, s.scheduled_end, s.status::text,
         es.geofence_latitude, es.geofence_longitude, COALESCE(es.geofence_radius_m, 100)
  FROM shifts s
  JOIN establishment_technical_rooms t ON t.room_id = s.room_id
  JOIN locations l ON l.id = t.location_id AND l.organization_id = s.organization_id
  JOIN organizations o ON o.id = s.organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME'
  JOIN assignments a ON a.shift_id = s.id AND a.organization_id = s.organization_id AND a.response_status = 'accepted'
  JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id AND m.status = 'active'
  JOIN workers w ON w.id = m.worker_id
  LEFT JOIN establishment_settings es ON es.location_id = l.id
  WHERE s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND (CASE WHEN p_shift_id IS NOT NULL THEN s.id = p_shift_id
              ELSE s.scheduled_end >= p_from AND s.scheduled_start <= p_to AND s.status::text <> 'cancelled' END)
  ORDER BY s.scheduled_start, s.id
$$;
REVOKE ALL ON FUNCTION public.app_attendance_my_shifts(timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_my_shifts(timestamptz, timestamptz, uuid) TO app_runtime;

-- 4. RLS y permisos ------------------------------------------------------------------------------------------------
ALTER TABLE attendance_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_geo_consents ENABLE ROW LEVEL SECURITY;

-- Ponches: la persona ve los suyos; la administración, los de su hogar.
DROP POLICY IF EXISTS attendance_punches_read ON attendance_punches;
CREATE POLICY attendance_punches_read ON attendance_punches FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_org_manager()))
  OR app_is_superadmin());
DROP POLICY IF EXISTS attendance_punches_self_insert ON attendance_punches;
CREATE POLICY attendance_punches_self_insert ON attendance_punches FOR INSERT WITH CHECK (
  origin IN ('online', 'offline')
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS attendance_punches_manual_insert ON attendance_punches;
CREATE POLICY attendance_punches_manual_insert ON attendance_punches FOR INSERT WITH CHECK (
  origin = 'manual'
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager() AND app_org_is_residential(organization_id));

-- Consentimiento: cada persona el suyo (leer, aceptar, revocar); la administración solo lo lee.
DROP POLICY IF EXISTS attendance_geo_consents_read ON attendance_geo_consents;
CREATE POLICY attendance_geo_consents_read ON attendance_geo_consents FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_org_manager()))
  OR app_is_superadmin());
DROP POLICY IF EXISTS attendance_geo_consents_self_insert ON attendance_geo_consents;
CREATE POLICY attendance_geo_consents_self_insert ON attendance_geo_consents FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_org_is_residential(organization_id)
  AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = attendance_geo_consents.organization_id
              AND m.user_id = attendance_geo_consents.user_id AND m.status = 'active'));
DROP POLICY IF EXISTS attendance_geo_consents_self_update ON attendance_geo_consents;
CREATE POLICY attendance_geo_consents_self_update ON attendance_geo_consents FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

GRANT SELECT, INSERT ON attendance_punches TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON attendance_geo_consents TO app_runtime;

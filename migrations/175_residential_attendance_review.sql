-- 175 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F4 (3 de 3): revisión, correcciones, alertas y políticas.
-- 26-nov-2026. Fuente oficial: plan de implementación definitivo (D3; D4; §5; §6 F4; §7).
--
-- Depende de la 173 y la 174. No modifica la tabla shifts. Nada se enciende (HOGAR_PONCHES apagado por defecto).
--
--   * attendance_policies: por establecimiento y versionadas (solo anexos): transición del código (0–12 h) y
--     tolerancias para tardanzas, salidas anticipadas y ausencias. Son datos administrativos: nunca descuentan horas.
--   * attendance_reviews: cada decisión de la administración (validado, justificado, no reconocido), siempre con motivo,
--     una por una o en bloque. Solo anexos: el ponche original no cambia; vale la última decisión.
--   * attendance_correction_requests: la persona pide corregir un ponche suyo o añadir uno que falta; la
--     administración aprueba (crea un ponche manual justificado) o rechaza, con motivo.
--   * attendance_alerts: fuera del perímetro (cada ponche), reincidencia (3 en 7 días; no es prueba de fraude), sesión
--     abierta 16 h (sin cierre automático) e intentos bloqueados. Avisos a la administración sin datos personales.
-- Nadie revisa, decide ni poncha manualmente sobre sí mismo.
-- Reversión: ops/175_residential_attendance_review.rollback.sql.

-- 1. Tablas ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_policies (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               uuid NOT NULL,
  location_id                   uuid NOT NULL,
  version                       integer NOT NULL CHECK (version >= 1),
  transition_hours              smallint NOT NULL DEFAULT 8 CHECK (transition_hours BETWEEN 0 AND 12),
  late_tolerance_minutes        smallint NOT NULL DEFAULT 10 CHECK (late_tolerance_minutes BETWEEN 0 AND 120),
  early_leave_tolerance_minutes smallint NOT NULL DEFAULT 10 CHECK (early_leave_tolerance_minutes BETWEEN 0 AND 120),
  absence_after_minutes         smallint NOT NULL DEFAULT 60 CHECK (absence_after_minutes BETWEEN 15 AND 720),
  reason                        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  created_by_user_id            uuid NOT NULL REFERENCES users (id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, version),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);

CREATE TABLE IF NOT EXISTS attendance_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  punch_id         uuid NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('validated', 'justified', 'not_recognized')),
  reason           text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  batch_id         uuid NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users (id),
  reviewed_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (punch_id, organization_id) REFERENCES attendance_punches (id, organization_id)
);
CREATE INDEX IF NOT EXISTS attendance_reviews_punch_idx ON attendance_reviews (punch_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS attendance_correction_requests (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL,
  location_id                       uuid NOT NULL,
  shift_id                          uuid NOT NULL,
  organization_worker_membership_id uuid NOT NULL,
  user_id                           uuid NOT NULL REFERENCES users (id),
  punch_id                          uuid NULL,                 -- NULL: falta un ponche
  requested_type                    text NOT NULL CHECK (requested_type IN ('in', 'out', 'break_start', 'break_end', 'meal_start', 'meal_end')),
  requested_at                      timestamptz NOT NULL,
  reason                            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  status                            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by_user_id                uuid NULL REFERENCES users (id),
  decided_at                        timestamptz NULL,
  decision_reason                   text NULL CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 3 AND 300),
  resulting_punch_id                uuid NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (punch_id, organization_id) REFERENCES attendance_punches (id, organization_id),
  FOREIGN KEY (resulting_punch_id, organization_id) REFERENCES attendance_punches (id, organization_id),
  CHECK ((status = 'pending') = (decided_at IS NULL AND decided_by_user_id IS NULL AND decision_reason IS NULL)),
  CHECK (status <> 'approved' OR resulting_punch_id IS NOT NULL),
  CHECK (status = 'approved' OR resulting_punch_id IS NULL)
);
CREATE INDEX IF NOT EXISTS attendance_corrections_status_idx ON attendance_correction_requests (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_alerts (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL,
  location_id                       uuid NOT NULL,
  kind                              text NOT NULL CHECK (kind IN ('outside_perimeter', 'recidivism', 'long_session', 'attempts_blocked')),
  user_id                           uuid NULL REFERENCES users (id),
  organization_worker_membership_id uuid NULL,
  punch_id                          uuid NULL,
  alert_key                         text NOT NULL,             -- deduplicación por tipo
  created_at                        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at                   timestamptz NULL,
  acknowledged_by_user_id           uuid NULL REFERENCES users (id),
  UNIQUE (organization_id, kind, alert_key),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (punch_id, organization_id) REFERENCES attendance_punches (id, organization_id),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS attendance_alerts_open_idx ON attendance_alerts (organization_id, created_at DESC) WHERE acknowledged_at IS NULL;

-- 2. Guardas -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_attendance_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
  IF NEW.version <> COALESCE((SELECT max(p.version) FROM attendance_policies p WHERE p.location_id = NEW.location_id), 0) + 1 THEN
    RAISE EXCEPTION 'ATTENDANCE_POLICY_VERSION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_policy_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_policies_guard ON attendance_policies;
CREATE TRIGGER attendance_policies_guard BEFORE INSERT ON attendance_policies
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_policy_guard();
DROP TRIGGER IF EXISTS attendance_policies_append_only ON attendance_policies;
CREATE TRIGGER attendance_policies_append_only BEFORE UPDATE OR DELETE ON attendance_policies
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- Revisión: de la administración del hogar, sobre un ponche de su organización, nunca uno propio.
CREATE OR REPLACE FUNCTION public.app_attendance_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_punch_user uuid;
BEGIN
  SELECT p.user_id INTO v_punch_user FROM attendance_punches p WHERE p.id = NEW.punch_id AND p.organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_user IS NULL OR NEW.reviewer_user_id IS DISTINCT FROM v_user OR v_user = v_punch_user OR NOT public.app_is_org_manager() THEN
    RAISE EXCEPTION 'ATTENDANCE_SELF_REVIEW' USING ERRCODE = 'P0001';
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_review_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_reviews_guard ON attendance_reviews;
CREATE TRIGGER attendance_reviews_guard BEFORE INSERT ON attendance_reviews
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_review_guard();
DROP TRIGGER IF EXISTS attendance_reviews_append_only ON attendance_reviews;
CREATE TRIGGER attendance_reviews_append_only BEFORE UPDATE OR DELETE ON attendance_reviews
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- Correcciones: la persona las pide para sí (turno suyo, con asignación aceptada); la administración decide una vez.
CREATE OR REPLACE FUNCTION public.app_attendance_correction_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_tech uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
    SELECT t.room_id INTO v_tech FROM establishment_technical_rooms t WHERE t.location_id = NEW.location_id;
    IF v_user IS NULL OR NEW.user_id IS DISTINCT FROM v_user
       OR NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = NEW.shift_id AND s.organization_id = NEW.organization_id AND s.room_id = v_tech)
       OR NOT EXISTS (SELECT 1 FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
                      WHERE m.id = NEW.organization_worker_membership_id AND m.organization_id = NEW.organization_id AND w.user_id = NEW.user_id)
       OR NOT EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                      AND a.organization_worker_membership_id = NEW.organization_worker_membership_id AND a.response_status = 'accepted') THEN
      RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.punch_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM attendance_punches p WHERE p.id = NEW.punch_id AND p.user_id = NEW.user_id AND p.shift_id = NEW.shift_id) THEN
      RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
    END IF;
    NEW.status := 'pending'; NEW.decided_by_user_id := NULL; NEW.decided_at := NULL; NEW.decision_reason := NULL;
    NEW.resulting_punch_id := NULL; NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- Decisión: una sola vez, de la administración, nunca sobre una petición propia; el resto no cambia.
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.organization_worker_membership_id IS DISTINCT FROM OLD.organization_worker_membership_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.punch_id IS DISTINCT FROM OLD.punch_id OR NEW.requested_type IS DISTINCT FROM OLD.requested_type
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_user IS NULL OR NEW.decided_by_user_id IS DISTINCT FROM v_user OR v_user = OLD.user_id OR NOT public.app_is_org_manager() THEN
    RAISE EXCEPTION 'ATTENDANCE_SELF_REVIEW' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.resulting_punch_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM attendance_punches p WHERE p.id = NEW.resulting_punch_id AND p.origin = 'manual'
         AND p.user_id = OLD.user_id AND p.shift_id = OLD.shift_id) THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_correction_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_correction_requests_guard ON attendance_correction_requests;
CREATE TRIGGER attendance_correction_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_correction_guard();

-- Alertas: solo se marcan como vistas (una vez); nunca se editan ni se borran.
CREATE OR REPLACE FUNCTION public.app_attendance_alert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
    NEW.created_at := now(); NEW.acknowledged_at := NULL; NEW.acknowledged_by_user_id := NULL;
    RETURN NEW;
  END IF;
  IF OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL
     OR NEW.acknowledged_by_user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid
     OR (to_jsonb(NEW) - 'acknowledged_at' - 'acknowledged_by_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_at' - 'acknowledged_by_user_id') THEN
    RAISE EXCEPTION 'ATTENDANCE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  NEW.acknowledged_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_alert_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS attendance_alerts_guard ON attendance_alerts;
CREATE TRIGGER attendance_alerts_guard BEFORE INSERT OR UPDATE OR DELETE ON attendance_alerts
  FOR EACH ROW EXECUTE FUNCTION public.app_attendance_alert_guard();

-- 3. Alertas y avisos (SECURITY DEFINER) ------------------------------------------------------------------------------
-- Aviso general a la administración del hogar: tipo y entidad, sin nombres, horas ni ubicación.
CREATE OR REPLACE FUNCTION public.app_attendance_notify_managers(p_organization_id uuid, p_type text, p_alert_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
  SELECT DISTINCT m.user_id, p_organization_id, p_type, 'attendance_alert', p_alert_id, 'in_app', 'sent', now()
  FROM organization_memberships m
  JOIN user_roles ur ON ur.organization_membership_id = m.id
  JOIN roles ro ON ro.id = ur.role_id AND ro.code IN ('ORGANIZATION_ADMIN', 'SUPERVISOR')
  WHERE m.organization_id = p_organization_id AND m.status = 'active';
$$;
REVOKE ALL ON FUNCTION public.app_attendance_notify_managers(uuid, text, uuid) FROM PUBLIC;

-- Tras un ponche: fuera del perímetro → alerta (una por ponche); 3 o más fuera en 7 días → reincidencia (una por día).
-- Solo la persona del ponche o la administración de su hogar, en la organización de la sesión.
CREATE OR REPLACE FUNCTION public.app_attendance_record_punch_alerts(p_punch_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  p record;
  v_id uuid;
  v_count integer := 0;
BEGIN
  SELECT * INTO p FROM attendance_punches x WHERE x.id = p_punch_id AND x.organization_id = v_org;
  IF NOT FOUND OR (p.user_id <> v_user AND NOT public.app_is_org_manager()) THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF p.location_status <> 'outside' THEN RETURN 0; END IF;
  INSERT INTO attendance_alerts (organization_id, location_id, kind, user_id, organization_worker_membership_id, punch_id, alert_key)
  VALUES (p.organization_id, p.location_id, 'outside_perimeter', p.user_id, p.organization_worker_membership_id, p.id, p.id::text)
  ON CONFLICT (organization_id, kind, alert_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    PERFORM public.app_attendance_notify_managers(p.organization_id, 'ATTENDANCE_REVIEW_NEEDED', v_id);
    v_count := v_count + 1; v_id := NULL;
  END IF;
  IF (SELECT count(*) FROM attendance_punches x WHERE x.user_id = p.user_id AND x.location_id = p.location_id
        AND x.location_status = 'outside' AND x.effective_at > p.effective_at - interval '7 days' AND x.effective_at <= p.effective_at) >= 3 THEN
    INSERT INTO attendance_alerts (organization_id, location_id, kind, user_id, organization_worker_membership_id, punch_id, alert_key)
    VALUES (p.organization_id, p.location_id, 'recidivism', p.user_id, p.organization_worker_membership_id, p.id,
            p.user_id::text || ':' || p.location_id::text || ':' || to_char(p.effective_at AT TIME ZONE 'America/Puerto_Rico', 'YYYY-MM-DD'))
    ON CONFLICT (organization_id, kind, alert_key) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      PERFORM public.app_attendance_notify_managers(p.organization_id, 'ATTENDANCE_ALERT', v_id);
      v_count := v_count + 1;
    END IF;
  END IF;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_record_punch_alerts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_record_punch_alerts(uuid) TO app_runtime;

-- Intentos bloqueados: una alerta por persona, establecimiento y franja de 15 minutos.
CREATE OR REPLACE FUNCTION public.app_attendance_record_blocked_attempt(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT EXISTS (
       SELECT 1 FROM organization_memberships m WHERE m.organization_id = v_org AND m.user_id = v_user AND m.status = 'active')
     OR NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = p_location_id AND l.organization_id = v_org) THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO attendance_alerts (organization_id, location_id, kind, user_id, alert_key)
  VALUES (v_org, p_location_id, 'attempts_blocked', v_user,
          v_user::text || ':' || p_location_id::text || ':' || floor(extract(epoch FROM now()) / 900)::bigint::text)
  ON CONFLICT (organization_id, kind, alert_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    PERFORM public.app_attendance_notify_managers(v_org, 'ATTENDANCE_ALERT', v_id);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_record_blocked_attempt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_record_blocked_attempt(uuid) TO app_runtime;

-- Trabajo programado: sesiones abiertas 16 h o más (entrada sin salida posterior) → alerta, sin cierre automático.
CREATE OR REPLACE FUNCTION public.app_attendance_scan_long_sessions(p_now timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
  v_id uuid;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT i.* FROM attendance_punches i
    WHERE i.punch_type = 'in' AND i.effective_at <= p_now - interval '16 hours' AND i.effective_at > p_now - interval '7 days'
      AND public.app_org_feature_enabled(i.organization_id, 'HOGAR_PONCHES')
      AND NOT EXISTS (SELECT 1 FROM attendance_punches o WHERE o.session_in_punch_id = i.id AND o.punch_type = 'out')
      AND NOT EXISTS (SELECT 1 FROM attendance_punches o WHERE o.user_id = i.user_id AND o.shift_id = i.shift_id
                        AND o.punch_type = 'out' AND o.origin = 'manual' AND o.effective_at > i.effective_at)
  LOOP
    INSERT INTO attendance_alerts (organization_id, location_id, kind, user_id, organization_worker_membership_id, punch_id, alert_key)
    VALUES (r.organization_id, r.location_id, 'long_session', r.user_id, r.organization_worker_membership_id, r.id, r.id::text)
    ON CONFLICT (organization_id, kind, alert_key) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      PERFORM public.app_attendance_notify_managers(r.organization_id, 'ATTENDANCE_ALERT', v_id);
      v_count := v_count + 1; v_id := NULL;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.app_attendance_scan_long_sessions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_attendance_scan_long_sessions(timestamptz) TO app_runtime;

-- 4. RLS y permisos ------------------------------------------------------------------------------------------------
ALTER TABLE attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_alerts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_policies','attendance_reviews','attendance_alerts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_read', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin())$p$,
      t || '_manager_read', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['attendance_policies','attendance_reviews'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_insert', t);
  END LOOP;
END;
$$;
-- La persona ve las decisiones sobre SUS ponches (la revisión de su asistencia); la administración, todas.
DROP POLICY IF EXISTS attendance_reviews_self_read ON attendance_reviews;
CREATE POLICY attendance_reviews_self_read ON attendance_reviews FOR SELECT USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM attendance_punches p WHERE p.id = attendance_reviews.punch_id
              AND p.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid));
-- La persona ve la política de su establecimiento (para entender tardanzas); no la cambia.
DROP POLICY IF EXISTS attendance_policies_member_read ON attendance_policies;
CREATE POLICY attendance_policies_member_read ON attendance_policies FOR SELECT USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = attendance_policies.organization_id
              AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND m.status = 'active'));
DROP POLICY IF EXISTS attendance_alerts_manager_update ON attendance_alerts;
CREATE POLICY attendance_alerts_manager_update ON attendance_alerts FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager())
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager());

DROP POLICY IF EXISTS attendance_corrections_read ON attendance_correction_requests;
CREATE POLICY attendance_corrections_read ON attendance_correction_requests FOR SELECT USING (
  (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
   AND (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid OR app_is_org_manager()))
  OR app_is_superadmin());
DROP POLICY IF EXISTS attendance_corrections_self_insert ON attendance_correction_requests;
CREATE POLICY attendance_corrections_self_insert ON attendance_correction_requests FOR INSERT WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  AND app_org_is_residential(organization_id));
DROP POLICY IF EXISTS attendance_corrections_manager_update ON attendance_correction_requests;
CREATE POLICY attendance_corrections_manager_update ON attendance_correction_requests FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id));

GRANT SELECT, INSERT ON attendance_policies, attendance_reviews TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON attendance_correction_requests TO app_runtime;
GRANT SELECT, UPDATE ON attendance_alerts TO app_runtime;
-- Las alertas solo las crean las funciones SECURITY DEFINER de arriba: app_runtime no inserta alertas directamente.

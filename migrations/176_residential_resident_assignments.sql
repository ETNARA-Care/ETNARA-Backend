-- 176 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F3: asignación de residentes por turno y sustitución
-- administrativa (D7). 26-nov-2026. Fuente oficial: plan de implementación definitivo (D2; D7; §2 «lo que se toca de lo
-- compartido»; §3 casos límite; §6 F3; §7).
--
-- Depende de la 171 (habitación técnica), la 172 (calendario) y la 173–175 (ponches). No modifica la tabla shifts.
-- Nada se enciende: la asignación va detrás de HOGAR_ASIGNACIONES y la sustitución exige además HOGAR_CALENDARIO.
--
--   * shift_resident_assignments: qué residentes atiende cada persona en un turno del establecimiento, por PERIODO
--     [effective_from, effective_until). Redistribuir o sustituir cierra y abre a la misma hora efectiva: nunca
--     coinciden dos accesos por una sustitución. No llevan tiempo trabajado: en hogares las horas salen solo de los ponches.
--   * shift_substitutions: cada sustitución administrativa (solo anexos): original, sustituta, hora efectiva, motivo
--     sin datos de salud, aviso de disponibilidad confirmado, transferencias y residentes que quedan sin cobertura.
--   * shift_coverage_alerts: residentes sin cobertura confirmados con motivo (alerta pendiente).
--   * app_residential_substitute_shift(): la parte de escritura de la sustitución, en una sola transacción.
--
-- Lo compartido que se toca (lista cerrada del plan):
--   * app_worker_has_recipient_assignment(): rama nueva, solo con asignaciones de residentes activas ahora;
--   * app_worker_messaging_window(): rama nueva, solo en hogares y solo durante la asignación activa;
--   * disparador nuevo en care_recipients: al trasladar o desactivar a un residente de un hogar se cierran sus asignaciones.
-- Las ramas de agencias e independientes quedan exactamente como estaban (132 y 134).
-- Reversión: ops/176_residential_resident_assignments.rollback.sql.

-- 1. Tablas ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_substitutions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  location_id                uuid NOT NULL,
  shift_id                   uuid NOT NULL,
  original_membership_id     uuid NOT NULL,
  substitute_membership_id   uuid NOT NULL,
  effective_at               timestamptz NOT NULL,
  full_replacement           boolean NOT NULL,
  reason_code                text NOT NULL CHECK (reason_code IN ('unplanned_absence', 'operational', 'schedule_change', 'other')),
  reason_note                text NULL CHECK (reason_note IS NULL OR char_length(reason_note) <= 300),
  availability_warning       boolean NOT NULL DEFAULT false,
  availability_confirmed     boolean NOT NULL DEFAULT false,
  transfers                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncovered                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncovered_confirmed        boolean NOT NULL DEFAULT false,
  created_by_user_id         uuid NOT NULL REFERENCES users (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (original_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (substitute_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  CHECK (original_membership_id <> substitute_membership_id),
  CHECK (NOT availability_warning OR availability_confirmed),
  CHECK (jsonb_typeof(transfers) = 'array' AND jsonb_typeof(uncovered) = 'array'),
  CHECK (jsonb_array_length(uncovered) = 0 OR uncovered_confirmed)
);
CREATE INDEX IF NOT EXISTS shift_substitutions_shift_idx ON shift_substitutions (shift_id, effective_at);
-- Una persona se sustituye una sola vez en un turno (27-nov): su cobertura termina en la hora efectiva y nunca hay dos
-- sustitutas a la vez en su lugar. Para cambiar a la sustituta se sustituye a la sustituta.
CREATE UNIQUE INDEX IF NOT EXISTS shift_substitutions_original_once_uidx ON shift_substitutions (shift_id, original_membership_id);

CREATE TABLE IF NOT EXISTS shift_resident_assignments (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL,
  location_id                       uuid NOT NULL,
  shift_id                          uuid NOT NULL,
  organization_worker_membership_id uuid NOT NULL,
  care_recipient_id                 uuid NOT NULL,
  effective_from                    timestamptz NOT NULL,
  effective_until                   timestamptz NULL,          -- NULL: hasta el fin de su cobertura del turno
  origin                            text NOT NULL DEFAULT 'assignment' CHECK (origin IN ('assignment', 'redistribution', 'substitution')),
  substitution_id                   uuid NULL,
  close_reason                      text NULL CHECK (close_reason IN ('ended', 'redistribution', 'substitution', 'transfer', 'resident_inactive')),
  closed_at                         timestamptz NULL,
  closed_by_user_id                 uuid NULL REFERENCES users (id),
  created_by_user_id                uuid NOT NULL REFERENCES users (id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (organization_worker_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id),
  FOREIGN KEY (substitution_id, organization_id) REFERENCES shift_substitutions (id, organization_id),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK ((effective_until IS NULL) = (close_reason IS NULL AND closed_at IS NULL)),
  CHECK ((origin = 'substitution') = (substitution_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS shift_resident_assignments_recipient_idx ON shift_resident_assignments (care_recipient_id, effective_from);
CREATE INDEX IF NOT EXISTS shift_resident_assignments_shift_idx ON shift_resident_assignments (shift_id, organization_worker_membership_id);

CREATE TABLE IF NOT EXISTS shift_coverage_alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  location_id         uuid NOT NULL,
  shift_id            uuid NOT NULL,
  care_recipient_id   uuid NOT NULL,
  uncovered_from      timestamptz NOT NULL,
  reason              text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  substitution_id     uuid NULL,
  created_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz NULL,
  resolved_by_user_id uuid NULL REFERENCES users (id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id),
  FOREIGN KEY (care_recipient_id, organization_id) REFERENCES care_recipients (id, organization_id),
  FOREIGN KEY (substitution_id, organization_id) REFERENCES shift_substitutions (id, organization_id),
  CHECK ((resolved_at IS NULL) = (resolved_by_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS shift_coverage_alerts_open_idx ON shift_coverage_alerts (organization_id, created_at DESC) WHERE resolved_at IS NULL;

-- 2. Cobertura de una persona en un turno -----------------------------------------------------------------------
-- Sin sustituciones: el turno entero. Si sustituyó a alguien: desde la hora efectiva. Si la sustituyeron: hasta la
-- hora efectiva. Es la base del «solape real» (turnos nocturnos, cambios de fecha y sustituciones parciales), del
-- acceso a residentes y de que las horas no se dupliquen.
CREATE OR REPLACE FUNCTION public.app_residential_coverage_bounds(p_shift_id uuid, p_membership_id uuid)
RETURNS TABLE (cov_start timestamptz, cov_end timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(s.scheduled_start, COALESCE((SELECT max(x.effective_at) FROM shift_substitutions x
                                               WHERE x.shift_id = s.id AND x.substitute_membership_id = p_membership_id), s.scheduled_start)),
         LEAST(s.scheduled_end, COALESCE((SELECT min(x.effective_at) FROM shift_substitutions x
                                          WHERE x.shift_id = s.id AND x.original_membership_id = p_membership_id), s.scheduled_end))
  FROM shifts s WHERE s.id = p_shift_id
$$;
REVOKE ALL ON FUNCTION public.app_residential_coverage_bounds(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_coverage_bounds(uuid, uuid) TO app_runtime;

-- Solape real: ¿la persona ya cubre otro turno no cancelado en [p_from, p_to)? (asignaciones pendientes o aceptadas,
-- recortadas por sus sustituciones). Solo responde a la administración de la organización de la sesión.
CREATE OR REPLACE FUNCTION public.app_residential_membership_busy(p_membership_id uuid, p_from timestamptz, p_to timestamptz, p_except_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.app_is_org_manager() AND EXISTS (
    SELECT 1 FROM assignments a
    JOIN shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
    CROSS JOIN LATERAL public.app_residential_coverage_bounds(s.id, a.organization_worker_membership_id) c
    WHERE a.organization_worker_membership_id = p_membership_id
      AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND a.response_status IN ('pending', 'accepted')
      AND s.status::text <> 'cancelled'
      AND s.id IS DISTINCT FROM p_except_shift_id
      AND c.cov_end > c.cov_start
      AND c.cov_start < p_to AND c.cov_end > p_from)
$$;
REVOKE ALL ON FUNCTION public.app_residential_membership_busy(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_membership_busy(uuid, timestamptz, timestamptz, uuid) TO app_runtime;

-- 3. Guardas -------------------------------------------------------------------------------------------------------
-- Asignaciones de residentes: solo hogares, turno del establecimiento no cancelado, persona con asignación aceptada en
-- ese turno y membresía activa, residente activo del mismo establecimiento, dentro de la cobertura de esa persona, sin
-- fechas hacia atrás y sin dos periodos abiertos iguales. Solo se cierran (una vez); nunca se borran.
CREATE OR REPLACE FUNCTION public.app_residential_assignment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tech uuid;
  v_shift record;
  v_cov record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.organization_worker_membership_id IS DISTINCT FROM OLD.organization_worker_membership_id
       OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.substitution_id IS DISTINCT FROM OLD.substitution_id
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.effective_until IS NOT NULL OR NEW.effective_until IS NULL THEN
      RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    -- Cerrar nunca cambia nada hacia atrás (tolerancia de 2 min por la latencia).
    IF NEW.effective_until < now() - interval '2 minutes' AND NEW.effective_until > NEW.effective_from THEN
      RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_RETROACTIVE' USING ERRCODE = 'P0001';
    END IF;
    NEW.closed_at := now();
    RETURN NEW;
  END IF;
  PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
  SELECT t.room_id INTO v_tech FROM establishment_technical_rooms t WHERE t.location_id = NEW.location_id;
  SELECT s.id, s.status::text AS status, s.scheduled_start, s.scheduled_end INTO v_shift FROM shifts s
   WHERE s.id = NEW.shift_id AND s.organization_id = NEW.organization_id AND s.room_id = v_tech;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_SHIFT_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  IF v_shift.status = 'cancelled' THEN RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_SHIFT_CANCELLED' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM assignments a JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id
                 WHERE a.shift_id = NEW.shift_id AND a.organization_id = NEW.organization_id
                   AND a.organization_worker_membership_id = NEW.organization_worker_membership_id
                   AND a.response_status = 'accepted' AND m.status = 'active') THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_STAFF_NOT_ASSIGNED' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM care_recipients cr WHERE cr.id = NEW.care_recipient_id AND cr.organization_id = NEW.organization_id
                 AND cr.location_id = NEW.location_id AND cr.status = 'active') THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_RESIDENT_NOT_HERE' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_cov FROM public.app_residential_coverage_bounds(NEW.shift_id, NEW.organization_worker_membership_id);
  IF NEW.effective_from < v_cov.cov_start OR NEW.effective_from >= v_cov.cov_end THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_OUTSIDE_COVERAGE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.effective_from < now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_RETROACTIVE' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM shift_resident_assignments x
             WHERE x.shift_id = NEW.shift_id AND x.organization_worker_membership_id = NEW.organization_worker_membership_id
               AND x.care_recipient_id = NEW.care_recipient_id
               AND COALESCE(x.effective_until, v_cov.cov_end) > NEW.effective_from) THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_DUPLICATE' USING ERRCODE = 'P0001';
  END IF;
  NEW.effective_until := NULL; NEW.close_reason := NULL; NEW.closed_at := NULL; NEW.closed_by_user_id := NULL;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_assignment_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_resident_assignments_guard ON shift_resident_assignments;
CREATE TRIGGER shift_resident_assignments_guard BEFORE INSERT OR UPDATE OR DELETE ON shift_resident_assignments
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_assignment_guard();

-- Sustituciones: solo hogares, turno del establecimiento, de la administración del hogar; solo anexos.
CREATE OR REPLACE FUNCTION public.app_residential_substitution_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_tech uuid;
BEGIN
  PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
  SELECT t.room_id INTO v_tech FROM establishment_technical_rooms t WHERE t.location_id = NEW.location_id;
  IF NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = NEW.shift_id AND s.organization_id = NEW.organization_id AND s.room_id = v_tech
                   AND s.status::text <> 'cancelled' AND NEW.effective_at < s.scheduled_end) THEN
    RAISE EXCEPTION 'RESIDENTIAL_SUBSTITUTION_SHIFT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid OR NOT public.app_is_org_manager() THEN
    RAISE EXCEPTION 'RESIDENTIAL_MANAGER_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- La hora efectiva no cambia nada hacia atrás.
  IF NEW.effective_at < now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'RESIDENTIAL_SUBSTITUTION_RETROACTIVE' USING ERRCODE = 'P0001';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_substitution_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_substitutions_guard ON shift_substitutions;
CREATE TRIGGER shift_substitutions_guard BEFORE INSERT ON shift_substitutions
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_substitution_guard();
DROP TRIGGER IF EXISTS shift_substitutions_append_only ON shift_substitutions;
CREATE TRIGGER shift_substitutions_append_only BEFORE UPDATE OR DELETE ON shift_substitutions
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- Alertas de cobertura: se crean con motivo y solo se resuelven (una vez).
CREATE OR REPLACE FUNCTION public.app_residential_coverage_alert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_IMMUTABLE' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.app_attendance_location_guard(NEW.organization_id, NEW.location_id);
    NEW.created_at := now(); NEW.resolved_at := NULL; NEW.resolved_by_user_id := NULL;
    RETURN NEW;
  END IF;
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL
     OR NEW.resolved_by_user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid
     OR (to_jsonb(NEW) - 'resolved_at' - 'resolved_by_user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_at' - 'resolved_by_user_id') THEN
    RAISE EXCEPTION 'RESIDENTIAL_ASSIGNMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  NEW.resolved_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_coverage_alert_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS shift_coverage_alerts_guard ON shift_coverage_alerts;
CREATE TRIGGER shift_coverage_alerts_guard BEFORE INSERT OR UPDATE OR DELETE ON shift_coverage_alerts
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_coverage_alert_guard();

-- Traslado o baja de un residente de un hogar: sus asignaciones abiertas se cierran en la misma transacción (§3).
-- No hace nada fuera de hogares.
CREATE OR REPLACE FUNCTION public.app_residential_close_resident_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.app_org_is_residential(NEW.organization_id) THEN RETURN NEW; END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'active') THEN
    UPDATE shift_resident_assignments x
       SET effective_until = GREATEST(now(), x.effective_from),
           close_reason = CASE WHEN NEW.location_id IS DISTINCT FROM OLD.location_id THEN 'transfer' ELSE 'resident_inactive' END,
           closed_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
     WHERE x.care_recipient_id = NEW.id AND x.effective_until IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_close_resident_assignments() FROM PUBLIC;
DROP TRIGGER IF EXISTS care_recipients_residential_close_assignments ON care_recipients;
CREATE TRIGGER care_recipients_residential_close_assignments AFTER UPDATE OF location_id, status ON care_recipients
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_close_resident_assignments();

-- 4. Acceso a residentes (rama nueva, solo hogares) -------------------------------------------------------------------
-- Acceso de la persona de la sesión a un residente: una asignación ABIERTA ahora (desde ≤ ahora < hasta), de una
-- membresía activa con asignación aceptada, en un turno no cancelado, dentro de su cobertura.
CREATE OR REPLACE FUNCTION public.app_residential_user_has_recipient_now(p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM shift_resident_assignments x
    JOIN shifts s ON s.id = x.shift_id AND s.organization_id = x.organization_id
    JOIN organization_worker_memberships m ON m.id = x.organization_worker_membership_id AND m.status = 'active'
    JOIN workers w ON w.id = m.worker_id AND w.user_id = p_user_id
    JOIN organization_memberships om ON om.user_id = p_user_id AND om.organization_id = x.organization_id AND om.status = 'active'
    CROSS JOIN LATERAL public.app_residential_coverage_bounds(s.id, x.organization_worker_membership_id) c
    WHERE x.organization_id = p_organization_id
      AND x.care_recipient_id = p_care_recipient_id
      AND s.status::text <> 'cancelled'
      AND EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id = s.id AND a.organization_worker_membership_id = x.organization_worker_membership_id
                    AND a.response_status = 'accepted')
      AND x.effective_from <= now()
      AND now() < LEAST(COALESCE(x.effective_until, c.cov_end), c.cov_end)
  )
$$;
REVOKE ALL ON FUNCTION public.app_residential_user_has_recipient_now(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_user_has_recipient_now(uuid, uuid, uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_residential_worker_has_recipient(p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(public.app_residential_user_has_recipient_now(
    NULLIF(current_setting('app.current_user_id', true), '')::uuid,
    NULLIF(current_setting('app.current_org_id', true), '')::uuid,
    p_care_recipient_id), false)
$$;
REVOKE ALL ON FUNCTION public.app_residential_worker_has_recipient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_worker_has_recipient(uuid) TO app_runtime;

-- Eventos de cuidado en un hogar (§3: «aceptan a los residentes asignados en el turno»): ¿el turno es de un
-- establecimiento y desde cuándo la persona de la sesión tiene ahora a ese residente asignado EN ESE turno?
-- (En hogares no se usa la verificación de visita; las horas salen de los ponches.)
CREATE OR REPLACE FUNCTION public.app_residential_care_event_window(p_shift_id uuid, p_care_recipient_id uuid)
RETURNS TABLE (is_residential boolean, active_from timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM shifts s JOIN establishment_technical_rooms t ON t.room_id = s.room_id
                 WHERE s.id = p_shift_id AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid),
         (SELECT max(x.effective_from)
            FROM shift_resident_assignments x
            JOIN shifts s ON s.id = x.shift_id
            JOIN organization_worker_memberships m ON m.id = x.organization_worker_membership_id AND m.status = 'active'
            JOIN workers w ON w.id = m.worker_id AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
            CROSS JOIN LATERAL public.app_residential_coverage_bounds(s.id, x.organization_worker_membership_id) c
           WHERE x.shift_id = p_shift_id AND x.care_recipient_id = p_care_recipient_id
             AND x.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
             AND s.status::text <> 'cancelled'
             AND EXISTS (SELECT 1 FROM assignments a WHERE a.shift_id = s.id AND a.organization_worker_membership_id = x.organization_worker_membership_id
                           AND a.response_status = 'accepted')
             AND x.effective_from <= now() AND now() < LEAST(COALESCE(x.effective_until, c.cov_end), c.cov_end))
$$;
REVOKE ALL ON FUNCTION public.app_residential_care_event_window(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_care_event_window(uuid, uuid) TO app_runtime;

-- Función compartida (134) con la rama nueva al final; el resto, idéntico.
CREATE OR REPLACE FUNCTION public.app_worker_has_recipient_assignment(p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM assignments a
        JOIN organization_worker_memberships owm ON a.organization_worker_membership_id = owm.id
        JOIN shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
        WHERE a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
          AND owm.worker_id IN (SELECT worker_id FROM app_current_worker_ids())
          AND owm.status = 'active'
          AND a.response_status = 'accepted'
          AND s.status IN ('unassigned', 'confirmed', 'in_progress')
          AND (
            s.scheduled_end > now()
            OR (
              a.response_status = 'accepted'
              AND s.status = 'in_progress'
              AND EXISTS (
                SELECT 1
                FROM verification_events check_in
                WHERE check_in.organization_id = a.organization_id
                  AND check_in.shift_id = a.shift_id
                  AND check_in.organization_worker_membership_id = a.organization_worker_membership_id
                  AND check_in.event_type = 'check_in'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM verification_events check_out
                    WHERE check_out.organization_id = check_in.organization_id
                      AND check_out.shift_id = check_in.shift_id
                      AND check_out.organization_worker_membership_id = check_in.organization_worker_membership_id
                      AND check_out.event_type = 'check_out'
                      AND check_out.occurred_at > check_in.occurred_at
                  )
              )
            )
          )
          AND (
            a.care_recipient_id = p_care_recipient_id
            OR s.care_recipient_id = p_care_recipient_id
            OR (s.room_id IS NOT NULL AND s.room_id = app_recipient_room_id(p_care_recipient_id))
          )
    )
    -- 176 (hogares F3): rama nueva, solo con asignaciones de residentes activas ahora en turnos no cancelados.
    -- Esas asignaciones solo existen en hogares: para agencias e independientes el resultado no cambia.
    OR public.app_residential_worker_has_recipient(p_care_recipient_id);
$function$;


-- Ventana de mensajes (132) con la rama nueva al final; el resto, idéntico.
CREATE OR REPLACE FUNCTION app_worker_messaging_window(
  p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     AND (EXISTS (
       SELECT 1
       FROM public.assignments a
       JOIN public.organization_worker_memberships owm
         ON owm.id = a.organization_worker_membership_id
        AND owm.organization_id = a.organization_id
        AND owm.status = 'active'
       JOIN public.workers w ON w.id = owm.worker_id AND w.user_id = p_user_id
       JOIN public.organization_memberships om
         ON om.user_id = p_user_id AND om.organization_id = a.organization_id AND om.status = 'active'
       JOIN public.shifts s ON s.id = a.shift_id AND s.organization_id = a.organization_id
       WHERE a.organization_id = p_organization_id
         AND a.response_status = 'accepted'
         AND s.status IN ('confirmed', 'in_progress', 'completed')
         AND (
           s.care_recipient_id = p_care_recipient_id
           OR (s.care_recipient_id IS NULL
               AND (a.care_recipient_id = p_care_recipient_id
                    OR (s.room_id IS NOT NULL AND s.room_id = public.app_recipient_room_id(p_care_recipient_id))))
         )
         AND (
           -- her visit is open right now
           (s.status = 'in_progress' AND EXISTS (
              SELECT 1 FROM public.verification_events ci
              WHERE ci.organization_id = a.organization_id AND ci.shift_id = a.shift_id
                AND ci.organization_worker_membership_id = a.organization_worker_membership_id
                AND ci.event_type = 'check_in'
                AND NOT EXISTS (
                  SELECT 1 FROM public.verification_events co
                  WHERE co.organization_id = ci.organization_id AND co.shift_id = ci.shift_id
                    AND co.organization_worker_membership_id = ci.organization_worker_membership_id
                    AND co.event_type = 'check_out' AND co.occurred_at > ci.occurred_at)))
           -- or the shift has not ended, or ended less than 24 h ago
           OR now() < COALESCE(
                (SELECT max(co.created_at) FROM public.verification_events co
                  WHERE co.organization_id = a.organization_id AND co.shift_id = a.shift_id
                    AND co.organization_worker_membership_id = a.organization_worker_membership_id
                    AND co.event_type = 'check_out'),
                s.scheduled_end) + interval '24 hours'
         )
     )
     -- 176 (hogares F3): en un hogar, la conversación sobre un residente sale SOLO de su asignación activa ahora
     -- (sin las 24 h de gracia: con una sustitución nunca coinciden dos accesos).
     OR public.app_residential_user_has_recipient_now(p_user_id, p_organization_id, p_care_recipient_id));
$$;

-- 5. Ponches (174) por cobertura: «Ponchar» y su validación usan la parte del turno que cubre cada persona, para que
-- una sustitución parcial no duplique horas ni deje ponchar fuera de su parte (los ponches existentes no cambian).
CREATE OR REPLACE FUNCTION public.app_attendance_my_shifts(p_from timestamptz, p_to timestamptz, p_shift_id uuid DEFAULT NULL)
RETURNS TABLE (shift_id uuid, location_id uuid, location_name text, membership_id uuid, scheduled_start timestamptz, scheduled_end timestamptz,
               shift_status text, geofence_latitude numeric, geofence_longitude numeric, geofence_radius_m integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, l.id, l.name, a.organization_worker_membership_id, cov.cov_start, cov.cov_end, s.status::text,
         es.geofence_latitude, es.geofence_longitude, COALESCE(es.geofence_radius_m, 100)
  FROM shifts s
  JOIN establishment_technical_rooms t ON t.room_id = s.room_id
  JOIN locations l ON l.id = t.location_id AND l.organization_id = s.organization_id
  JOIN organizations o ON o.id = s.organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME'
  JOIN assignments a ON a.shift_id = s.id AND a.organization_id = s.organization_id AND a.response_status = 'accepted'
  JOIN organization_worker_memberships m ON m.id = a.organization_worker_membership_id AND m.status = 'active'
  JOIN workers w ON w.id = m.worker_id
  LEFT JOIN establishment_settings es ON es.location_id = l.id
  CROSS JOIN LATERAL public.app_residential_coverage_bounds(s.id, a.organization_worker_membership_id) cov
  WHERE cov.cov_end > cov.cov_start
    AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND w.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    AND (CASE WHEN p_shift_id IS NOT NULL THEN s.id = p_shift_id
              ELSE cov.cov_end >= p_from AND cov.cov_start <= p_to AND s.status::text <> 'cancelled' END)
  ORDER BY s.scheduled_start, s.id
$$;

-- 6. Sustitución (D7): la parte de escritura, todo o nada. La llama el servicio después de comprobar en la misma
-- transacción los bloqueos que no se pueden anular (elegibilidad y credenciales, puesto, autorización en el
-- establecimiento y solape real). Se ejecuta con los permisos de quien llama: RLS y guardas aplican.
CREATE OR REPLACE FUNCTION public.app_residential_substitute_shift(
  p_shift_id uuid, p_location_id uuid, p_original_membership_id uuid, p_substitute_membership_id uuid, p_effective_at timestamptz,
  p_reason_code text, p_reason_note text, p_availability_warning boolean, p_availability_confirmed boolean,
  p_transfers jsonb, p_uncovered jsonb, p_uncovered_confirmed boolean, p_coverage_reason text, p_role_in_shift text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_shift record;
  v_full boolean;
  v_id uuid;
  t jsonb;
  r uuid;
  v_week record;
  v_users uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('residential-substitute:' || p_shift_id::text));
  SELECT s.id, s.scheduled_start, s.scheduled_end INTO v_shift FROM shifts s WHERE s.id = p_shift_id AND s.organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  v_full := p_effective_at <= v_shift.scheduled_start;
  INSERT INTO shift_substitutions (organization_id, location_id, shift_id, original_membership_id, substitute_membership_id, effective_at,
    full_replacement, reason_code, reason_note, availability_warning, availability_confirmed, transfers, uncovered, uncovered_confirmed, created_by_user_id)
  VALUES (v_org, p_location_id, p_shift_id, p_original_membership_id, p_substitute_membership_id, GREATEST(p_effective_at, v_shift.scheduled_start),
    v_full, p_reason_code, NULLIF(btrim(p_reason_note), ''), p_availability_warning, p_availability_confirmed, p_transfers, p_uncovered, p_uncovered_confirmed, v_user)
  RETURNING id INTO v_id;
  -- La sustituta queda asignada por la administración (decisión administrativa, D7).
  INSERT INTO assignments (organization_id, shift_id, organization_worker_membership_id, care_recipient_id, role_in_shift, response_status, responded_at, response_reason)
  VALUES (v_org, p_shift_id, p_substitute_membership_id, NULL, p_role_in_shift, 'accepted', now(), 'Sustitución administrativa');
  -- El acceso de la original termina exactamente a la hora efectiva (o no empieza, si es una sustitución completa).
  UPDATE shift_resident_assignments x
     SET effective_until = GREATEST(GREATEST(p_effective_at, v_shift.scheduled_start), x.effective_from), close_reason = 'substitution', closed_by_user_id = v_user
   WHERE x.shift_id = p_shift_id AND x.organization_worker_membership_id = p_original_membership_id AND x.effective_until IS NULL;
  -- Transferencias (total o selectiva, también a varias personas) abren a la misma hora efectiva. Si la persona de
  -- destino ya atiende a ese residente (compartido), su periodo abierto continúa: no se duplica ni se interrumpe.
  FOR t IN SELECT * FROM jsonb_array_elements(p_transfers) LOOP
    INSERT INTO shift_resident_assignments (organization_id, location_id, shift_id, organization_worker_membership_id, care_recipient_id,
      effective_from, origin, substitution_id, created_by_user_id)
    SELECT v_org, p_location_id, p_shift_id, (t->>'toMembershipId')::uuid, (t->>'careRecipientId')::uuid,
      GREATEST(p_effective_at, v_shift.scheduled_start), 'substitution', v_id, v_user
     WHERE NOT EXISTS (SELECT 1 FROM shift_resident_assignments y WHERE y.shift_id = p_shift_id
       AND y.organization_worker_membership_id = (t->>'toMembershipId')::uuid AND y.care_recipient_id = (t->>'careRecipientId')::uuid
       AND y.effective_until IS NULL);
  END LOOP;
  -- Residentes que quedan sin cobertura: confirmados con motivo → alerta pendiente.
  FOR r IN SELECT (value #>> '{}')::uuid FROM jsonb_array_elements(p_uncovered) LOOP
    INSERT INTO shift_coverage_alerts (organization_id, location_id, shift_id, care_recipient_id, uncovered_from, reason, substitution_id, created_by_user_id)
    VALUES (v_org, p_location_id, p_shift_id, r, GREATEST(p_effective_at, v_shift.scheduled_start), p_coverage_reason, v_id, v_user);
  END LOOP;
  -- Sustitución completa (antes del inicio): la original deja de estar asignada (el historial queda en shift_substitutions).
  IF v_full THEN
    DELETE FROM assignments a WHERE a.shift_id = p_shift_id AND a.organization_worker_membership_id = p_original_membership_id
      AND a.response_status IN ('pending', 'accepted');
  END IF;
  -- Historial de versiones del calendario: la semana publicada que contiene el turno sube de versión.
  SELECT w.id, w.version INTO v_week FROM schedule_week_shifts e JOIN schedule_weeks w ON w.id = e.week_id WHERE e.shift_id = p_shift_id;
  IF FOUND AND v_week.version > 0 THEN
    UPDATE schedule_weeks SET version = v_week.version + 1 WHERE id = v_week.id;
    INSERT INTO schedule_week_publications (week_id, organization_id, version, published_by_user_id, shift_count, snapshot)
    VALUES (v_week.id, v_org, v_week.version + 1, v_user,
      (SELECT count(*) FROM schedule_week_shifts e WHERE e.week_id = v_week.id AND e.shift_id IS NOT NULL AND e.removed_at IS NULL),
      jsonb_build_array(jsonb_build_object('substitution', v_id, 'shiftId', p_shift_id, 'from', p_original_membership_id,
        'to', p_substitute_membership_id, 'effectiveAt', GREATEST(p_effective_at, v_shift.scheduled_start))));
  END IF;
  -- Aviso a ambos empleados, sin datos sensibles.
  SELECT array_agg(w.user_id) INTO v_users FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
   WHERE m.id = p_substitute_membership_id AND w.user_id IS NOT NULL;
  IF v_users IS NOT NULL THEN
    INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
    SELECT u, v_org, 'SHIFT_SUBSTITUTION_ASSIGNED', 'shift_substitution', v_id, 'in_app', 'sent', now() FROM unnest(v_users) u;
  END IF;
  SELECT array_agg(w.user_id) INTO v_users FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
   WHERE m.id = p_original_membership_id AND w.user_id IS NOT NULL;
  IF v_users IS NOT NULL THEN
    INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
    SELECT u, v_org, 'SHIFT_SUBSTITUTION_RELEASED', 'shift_substitution', v_id, 'in_app', 'sent', now() FROM unnest(v_users) u;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.app_residential_substitute_shift(uuid, uuid, uuid, uuid, timestamptz, text, text, boolean, boolean, jsonb, jsonb, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_substitute_shift(uuid, uuid, uuid, uuid, timestamptz, text, text, boolean, boolean, jsonb, jsonb, boolean, text, text) TO app_runtime;

-- 7. RLS y permisos ------------------------------------------------------------------------------------------------
ALTER TABLE shift_resident_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_substitutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_coverage_alerts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_resident_assignments','shift_substitutions','shift_coverage_alerts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_read', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin())$p$,
      t || '_manager_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_insert', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['shift_resident_assignments','shift_coverage_alerts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_update', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE
      USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_update', t);
  END LOOP;
END;
$$;
-- La persona ve SUS asignaciones de residentes (su lista del turno); nunca las de otras personas.
DROP POLICY IF EXISTS shift_resident_assignments_self_read ON shift_resident_assignments;
CREATE POLICY shift_resident_assignments_self_read ON shift_resident_assignments FOR SELECT USING (
  organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND public.app_is_own_worker_membership(organization_worker_membership_id));

GRANT SELECT, INSERT, UPDATE ON shift_resident_assignments, shift_coverage_alerts TO app_runtime;
GRANT SELECT, INSERT ON shift_substitutions TO app_runtime;

-- Avisos de la sustitución: la administración del hogar avisa a SU personal de una sustitución de SU hogar.
DROP POLICY IF EXISTS notifications_insert_shift_substitution ON notifications;
CREATE POLICY notifications_insert_shift_substitution ON notifications FOR INSERT WITH CHECK (
  notification_type IN ('SHIFT_SUBSTITUTION_ASSIGNED', 'SHIFT_SUBSTITUTION_RELEASED')
  AND related_entity_type = 'shift_substitution' AND channel = 'in_app' AND care_recipient_id IS NULL
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager() AND app_org_is_residential(organization_id)
  AND EXISTS (SELECT 1 FROM shift_substitutions x WHERE x.id = notifications.related_entity_id AND x.organization_id = notifications.organization_id)
  AND EXISTS (SELECT 1 FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
              WHERE m.organization_id = notifications.organization_id AND w.user_id = notifications.user_id));

-- 172 · Hogares de envejecientes (RESIDENTIAL_CARE_HOME), F2: calendario semanal del establecimiento. 26-nov-2026.
--
-- Fuente oficial: «ETNARA Care · Hogares de envejecientes: plan de implementación definitivo» (D2; §6 F2; §7).
-- Depende de la 171 (habitación técnica por establecimiento). No modifica la tabla shifts. Nada se enciende: las rutas
-- van detrás del interruptor HOGAR_CALENDARIO (apagado por defecto).
--
-- Modelo:
--   * schedule_weeks: una semana (lunes, hora de Puerto Rico) por establecimiento, en borrador o publicada, con versión.
--   * schedule_week_shifts: las entradas de la semana (inicio, fin, puesto, persona prevista). En borrador NO son
--     turnos: nadie del personal las ve. Al publicar, cada entrada nueva crea un turno real sobre la habitación técnica
--     del establecimiento (shift_id) y, si tiene persona, su asignación con las reglas de siempre (elegibilidad, sin
--     solapes). Quitar una entrada publicada la marca (removed_at) y, al volver a publicar, cancela su turno.
--   * schedule_week_publications: una fila por publicación (versión, recuentos, foto de los turnos). Solo anexos.
--   * schedule_templates / schedule_template_slots: plantillas por establecimiento (día, hora, duración, puesto, plazas).
--
-- Guardas en la base de datos (también contra app_runtime directo):
--   * solo organizaciones RESIDENTIAL_CARE_HOME, y solo establecimientos activos de esa organización;
--   * una entrada dura de 15 minutos a 24 horas y empieza dentro de su semana;
--   * una entrada publicada (con turno) no se edita: solo se marca para quitar; su turno es siempre la habitación técnica
--     de su establecimiento;
--   * escritura solo de la administración del hogar (RLS); las publicaciones no se modifican ni se borran.
-- Reversión: ops/172_residential_weekly_schedule.rollback.sql.

-- 1. Tablas ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  location_id        uuid NOT NULL,
  name               text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  archived_at        timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);
CREATE INDEX IF NOT EXISTS schedule_templates_location_idx ON schedule_templates (location_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS schedule_template_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      uuid NOT NULL,
  organization_id  uuid NOT NULL,
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),          -- ISO: 1 = lunes … 7 = domingo
  start_time       time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  required_role    text NOT NULL DEFAULT 'Cuidador/a' CHECK (char_length(btrim(required_role)) BETWEEN 1 AND 80),
  headcount        smallint NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 20),
  label            text NULL CHECK (label IS NULL OR char_length(label) <= 40),
  FOREIGN KEY (template_id, organization_id) REFERENCES schedule_templates (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS schedule_template_slots_template_idx ON schedule_template_slots (template_id);

CREATE TABLE IF NOT EXISTS schedule_weeks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  location_id             uuid NOT NULL,
  week_start              date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  version                 integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  has_unpublished_changes boolean NOT NULL DEFAULT false,
  published_at            timestamptz NULL,
  published_by_user_id    uuid NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, location_id, week_start),
  CHECK ((status = 'draft') = (version = 0)),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);

CREATE TABLE IF NOT EXISTS schedule_week_shifts (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id                          uuid NOT NULL,
  organization_id                  uuid NOT NULL,
  starts_at                        timestamptz NOT NULL,
  ends_at                          timestamptz NOT NULL,
  required_role                    text NOT NULL DEFAULT 'Cuidador/a' CHECK (char_length(btrim(required_role)) BETWEEN 1 AND 80),
  organization_worker_membership_id uuid NULL,
  label                            text NULL CHECK (label IS NULL OR char_length(label) <= 40),
  shift_id                         uuid NULL UNIQUE,
  removed_at                       timestamptz NULL,
  created_by_user_id               uuid NULL REFERENCES users (id),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at - starts_at BETWEEN interval '15 minutes' AND interval '24 hours'),
  CHECK (removed_at IS NULL OR shift_id IS NOT NULL),
  FOREIGN KEY (week_id, organization_id) REFERENCES schedule_weeks (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_worker_membership_id, organization_id) REFERENCES organization_worker_memberships (id, organization_id),
  FOREIGN KEY (shift_id, organization_id) REFERENCES shifts (id, organization_id)
);
CREATE INDEX IF NOT EXISTS schedule_week_shifts_week_idx ON schedule_week_shifts (week_id, starts_at);
CREATE INDEX IF NOT EXISTS schedule_week_shifts_worker_idx ON schedule_week_shifts (organization_worker_membership_id, starts_at)
  WHERE organization_worker_membership_id IS NOT NULL AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS schedule_week_publications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id              uuid NOT NULL,
  organization_id      uuid NOT NULL,
  version              integer NOT NULL CHECK (version >= 1),
  published_by_user_id uuid NULL REFERENCES users (id),
  shifts_created       integer NOT NULL DEFAULT 0,
  shifts_cancelled     integer NOT NULL DEFAULT 0,
  shift_count          integer NOT NULL DEFAULT 0,
  -- Foto de los turnos publicados: inicio, fin, puesto y membresía prevista. Sin nombres ni datos de residentes.
  snapshot             jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_id, version),
  FOREIGN KEY (week_id, organization_id) REFERENCES schedule_weeks (id, organization_id)
);

-- 2. Guardas -------------------------------------------------------------------------------------------------------
-- Solo hogares y solo establecimientos activos de la organización.
CREATE OR REPLACE FUNCTION public.app_schedule_location_guard(p_organization_id uuid, p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_organization_id AND o.organization_type = 'RESIDENTIAL_CARE_HOME') THEN
    RAISE EXCEPTION 'MODALITY_NOT_AVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = p_location_id AND l.organization_id = p_organization_id AND l.archived_at IS NULL) THEN
    RAISE EXCEPTION 'RESIDENTIAL_ESTABLISHMENT_CLOSED' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.app_schedule_location_guard(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.app_schedule_template_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.archived_at IS NULL THEN
    PERFORM public.app_schedule_location_guard(NEW.organization_id, NEW.location_id);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_schedule_template_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS schedule_templates_guard ON schedule_templates;
CREATE TRIGGER schedule_templates_guard BEFORE INSERT OR UPDATE ON schedule_templates
  FOR EACH ROW EXECUTE FUNCTION public.app_schedule_template_guard();

CREATE OR REPLACE FUNCTION public.app_schedule_week_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
                           OR NEW.week_start IS DISTINCT FROM OLD.week_start) THEN
    RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.version < OLD.version THEN
    RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.app_schedule_location_guard(NEW.organization_id, NEW.location_id);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_schedule_week_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS schedule_weeks_guard ON schedule_weeks;
CREATE TRIGGER schedule_weeks_guard BEFORE INSERT OR UPDATE ON schedule_weeks
  FOR EACH ROW EXECUTE FUNCTION public.app_schedule_week_guard();

-- Entradas: dentro de su semana; publicadas, inmutables salvo marcarlas para quitar; su turno es la habitación técnica.
CREATE OR REPLACE FUNCTION public.app_schedule_entry_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  w record;
  tech uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_PUBLISHED_ENTRY' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  SELECT sw.organization_id, sw.location_id, sw.week_start INTO w FROM schedule_weeks sw WHERE sw.id = NEW.week_id;
  IF NOT FOUND OR w.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.app_schedule_location_guard(NEW.organization_id, w.location_id);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.week_id IS DISTINCT FROM OLD.week_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.shift_id IS NOT NULL AND (NEW.shift_id IS DISTINCT FROM OLD.shift_id OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
        OR NEW.ends_at IS DISTINCT FROM OLD.ends_at OR NEW.required_role IS DISTINCT FROM OLD.required_role
        OR NEW.organization_worker_membership_id IS DISTINCT FROM OLD.organization_worker_membership_id
        OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at)) THEN
      RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_PUBLISHED_ENTRY' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.starts_at < (w.week_start::timestamp AT TIME ZONE 'America/Puerto_Rico')
     OR NEW.starts_at >= ((w.week_start + 7)::timestamp AT TIME ZONE 'America/Puerto_Rico') THEN
    RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_OUTSIDE_WEEK' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.shift_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.shift_id IS NULL) THEN
    SELECT t.room_id INTO tech FROM establishment_technical_rooms t WHERE t.location_id = w.location_id;
    IF NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = NEW.shift_id AND s.organization_id = NEW.organization_id AND s.room_id = tech) THEN
      RAISE EXCEPTION 'RESIDENTIAL_SCHEDULE_SHIFT_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_schedule_entry_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS schedule_week_shifts_guard ON schedule_week_shifts;
CREATE TRIGGER schedule_week_shifts_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_week_shifts
  FOR EACH ROW EXECUTE FUNCTION public.app_schedule_entry_guard();

CREATE OR REPLACE FUNCTION public.app_schedule_slot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE loc uuid;
BEGIN
  SELECT t.location_id INTO loc FROM schedule_templates t WHERE t.id = NEW.template_id AND t.organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESIDENTIAL_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.app_schedule_location_guard(NEW.organization_id, loc);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.app_schedule_slot_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS schedule_template_slots_guard ON schedule_template_slots;
CREATE TRIGGER schedule_template_slots_guard BEFORE INSERT OR UPDATE ON schedule_template_slots
  FOR EACH ROW EXECUTE FUNCTION public.app_schedule_slot_guard();

-- Publicaciones: solo anexos (función de la 171).
DROP TRIGGER IF EXISTS schedule_week_publications_append_only ON schedule_week_publications;
CREATE TRIGGER schedule_week_publications_append_only BEFORE UPDATE OR DELETE ON schedule_week_publications
  FOR EACH ROW EXECUTE FUNCTION public.app_residential_append_only();

-- 3. RLS y permisos: solo la administración del hogar ------------------------------------------------------------------
ALTER TABLE schedule_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_template_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_week_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_week_publications ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schedule_templates','schedule_template_slots','schedule_weeks','schedule_week_shifts','schedule_week_publications'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_read', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
      (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager()) OR app_is_superadmin())$p$,
      t || '_manager_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_insert', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_insert', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['schedule_templates','schedule_template_slots','schedule_weeks','schedule_week_shifts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_update', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR UPDATE
      USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))
      WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_update', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['schedule_template_slots','schedule_week_shifts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_manager_delete', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR DELETE USING (
      organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND app_is_org_manager() AND app_org_is_residential(organization_id))$p$,
      t || '_manager_delete', t);
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON schedule_templates, schedule_weeks TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_template_slots, schedule_week_shifts TO app_runtime;
GRANT SELECT, INSERT ON schedule_week_publications TO app_runtime;
-- Las guardas son SECURITY DEFINER y solo las llaman los disparadores: app_runtime no las ejecuta directamente.

-- 4. Avisos del calendario: la administración del hogar avisa a SU personal de una semana de SU hogar. Texto general
-- (el portal muestra «Horario semanal publicado/modificado»): sin nombres, residentes ni horarios en el aviso.
DROP POLICY IF EXISTS notifications_insert_schedule_week ON notifications;
CREATE POLICY notifications_insert_schedule_week ON notifications FOR INSERT WITH CHECK (
  notification_type IN ('SCHEDULE_WEEK_PUBLISHED', 'SCHEDULE_WEEK_UPDATED')
  AND related_entity_type = 'schedule_week' AND channel = 'in_app' AND care_recipient_id IS NULL
  AND organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  AND app_is_org_manager() AND app_org_is_residential(organization_id)
  AND EXISTS (SELECT 1 FROM schedule_weeks sw WHERE sw.id = notifications.related_entity_id AND sw.organization_id = notifications.organization_id)
  AND EXISTS (SELECT 1 FROM organization_worker_memberships m JOIN workers w ON w.id = m.worker_id
              WHERE m.organization_id = notifications.organization_id AND w.user_id = notifications.user_id));

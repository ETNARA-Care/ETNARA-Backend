-- 148 (4-nov-2026): tipos de registro de cuidado por defecto para cada agencia.
--
-- Hallazgo A1 de la validación de agencias fundadoras (4-nov): una agencia creada por
-- ETNARA Central no tenía ninguna fila en organization_care_event_types, así que
-- createCareEvent respondía 409 EVENT_TYPE_NOT_ENABLED a TODO registro (comidas,
-- hidratación, movilidad...). Solo scripts/seedDemo.ts insertaba esas filas, por eso
-- Casa Demo funcionaba y una agencia nueva no.
--
-- Referencia: Casa Demo habilita los 8 tipos del catálogo global de 016 con la
-- configuración por defecto de la tabla (is_enabled = true, sin etiqueta ni orden propios,
-- is_required = false). PHOTO va incluido igual que en Casa Demo: un registro PHOTO exige un
-- archivo y app_attach_activity_photo() lo rechaza (FEATURE_NOT_ENABLED) mientras la agencia
-- no tenga encendido ACTIVITY_PHOTOS, y el portal no ofrece ese tipo.
--
-- Qué hace:
--  1. app_default_care_event_type_codes(): la lista fija de 8 códigos (un tipo que se añada al
--     catálogo en el futuro NO se activa solo; se decide aparte).
--  2. Disparador AFTER INSERT ON organizations: toda agencia nueva recibe los 8 tipos,
--     venga de ETNARA Central, de un script o de una prueba. Es SECURITY DEFINER porque la
--     escritura en organization_care_event_types está reservada a la gestión de la agencia
--     (029) y la crea ETNARA Central; solo inserta filas de NEW.id, con ON CONFLICT DO NOTHING.
--  3. Relleno de las agencias existentes que NO tienen ninguna fila (nunca configuradas),
--     salvo las archivadas. Una agencia con cualquier fila propia ya decidió su configuración:
--     no se le añade, cambia ni duplica nada.
--  4. care_event_type_default_grants: registro de lo que insertó 148 (relleno o agencia nueva),
--     para que la reversión completa borre solo eso. Sin acceso para app_runtime.
--
-- Idempotente: CREATE OR REPLACE, IF NOT EXISTS, DROP TRIGGER IF EXISTS y ON CONFLICT DO NOTHING.
-- Reversión: ops/148_default_care_event_types.rollback.sql (por defecto conserva la
-- configuración creada; la variante completa la retira solo si nadie la modificó).

CREATE TABLE IF NOT EXISTS care_event_type_default_grants (
    organization_id     uuid NOT NULL REFERENCES organizations(id),
    care_event_type_id  uuid NOT NULL REFERENCES care_event_types(id),
    source              text NOT NULL CHECK (source IN ('backfill_148', 'new_agency')),
    granted_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, care_event_type_id)
);
ALTER TABLE care_event_type_default_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON care_event_type_default_grants FROM PUBLIC;
REVOKE ALL ON care_event_type_default_grants FROM app_runtime;

CREATE OR REPLACE FUNCTION public.app_default_care_event_type_codes()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$ SELECT ARRAY['MEAL','HYDRATION','TOILETING','MOBILITY','ACTIVITY','MOOD','NOTE','PHOTO']::text[] $$;

-- Inserta los tipos por defecto que falten para UNA agencia y registra cuáles insertó.
CREATE OR REPLACE FUNCTION public.app_provision_default_care_event_types(p_organization_id uuid, p_source text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_n integer;
BEGIN
  IF p_source NOT IN ('backfill_148', 'new_agency') THEN
    RAISE EXCEPTION 'INVALID_PROVISIONING_SOURCE' USING ERRCODE = '22023';
  END IF;
  WITH inserted AS (
    INSERT INTO public.organization_care_event_types (organization_id, care_event_type_id)
    SELECT p_organization_id, cet.id
      FROM public.care_event_types cet
     WHERE cet.code = ANY (public.app_default_care_event_type_codes())
    ON CONFLICT (organization_id, care_event_type_id) DO NOTHING
    RETURNING care_event_type_id
  ), logged AS (
    INSERT INTO public.care_event_type_default_grants (organization_id, care_event_type_id, source)
    SELECT p_organization_id, care_event_type_id, p_source FROM inserted
    ON CONFLICT (organization_id, care_event_type_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM inserted;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.app_on_organization_created_care_event_types()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.app_provision_default_care_event_types(NEW.id, 'new_agency');
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.app_provision_default_care_event_types(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_on_organization_created_care_event_types() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_default_care_event_type_codes() FROM PUBLIC;

DROP TRIGGER IF EXISTS organizations_default_care_event_types ON organizations;
CREATE TRIGGER organizations_default_care_event_types AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.app_on_organization_created_care_event_types();

-- Relleno: solo agencias sin ninguna configuración propia y no archivadas.
DO $$
DECLARE r record; v_orgs integer := 0; v_rows integer := 0; v_n integer;
BEGIN
  FOR r IN
    SELECT o.id FROM organizations o
     WHERE o.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM organization_care_event_types x WHERE x.organization_id = o.id)
     ORDER BY o.created_at, o.id
  LOOP
    v_n := public.app_provision_default_care_event_types(r.id, 'backfill_148');
    v_orgs := v_orgs + 1; v_rows := v_rows + v_n;
  END LOOP;
  RAISE NOTICE '148: % agencias sin configuración recibieron % tipos de registro por defecto', v_orgs, v_rows;
END $$;

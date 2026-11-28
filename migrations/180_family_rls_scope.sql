-- 180 · Seguridad: alcance de la familia en la RLS (agencias, independientes y hogares). Autorizado por Rafa el 26-nov-2026.
-- Hallazgo (docs/SEGURIDAD_RLS_FAMILIA_AGENCIAS.md): con app_runtime, un usuario solo-familia podía leer correos y
-- teléfonos de todo el personal y la administración, las credenciales de todo el personal, asignaciones de otros
-- residentes y todo el personal. La API nunca lo devolvía (sin exposición real encontrada); esta migración pone la
-- segunda capa.
-- «Solo familia» = en la organización actual tiene el rol FAMILY y NINGÚN otro rol (ORGANIZATION_ADMIN, SUPERVISOR,
-- WORKER) ni una membresía de empleado activa. Administración, supervisión y personal (aunque también sean familia)
-- conservan todos sus permisos; en otra organización cada persona tiene los permisos de su rol allí.
-- Lo que la familia sigue viendo (lo que ya usa su portal): los turnos de su familiar (directos o de su habitación),
-- sus asignaciones, y nombre y puesto del personal asignado a esos turnos o que registró actividades de su familiar;
-- de ese personal, si sigue activo, solo las credenciales vigentes aprobadas por esta organización. Su propia fila de
-- usuario. Ningún documento ni archivo profesional del personal. Nada más del personal.
-- Aditiva: solo funciones de lectura (SECURITY DEFINER, devuelven un sí/no) y políticas RESTRICTIVE para app_runtime.
-- Independiente de 171–177: no toca sus tablas ni funciones y usa nombres de política propios (family_scope_*), así que
-- el resultado es el mismo se aplique antes o después de ellas. No modifica shifts (estructura) ni datos.

-- Contexto actual (usuario y organización) sin RLS; nunca para ETNARA central.
CREATE OR REPLACE FUNCTION public.app_family_only_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH ctx AS (
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid AS u,
           NULLIF(current_setting('app.current_org_id', true), '')::uuid AS o
  )
  SELECT COALESCE((
    SELECT ctx.u IS NOT NULL AND ctx.o IS NOT NULL AND NOT public.app_is_superadmin()
       AND EXISTS (SELECT 1 FROM public.organization_memberships om
                   JOIN public.user_roles ur ON ur.organization_membership_id = om.id
                   JOIN public.roles r ON r.id = ur.role_id
                   WHERE om.user_id = ctx.u AND om.organization_id = ctx.o AND om.status = 'active' AND r.code = 'FAMILY')
       AND NOT EXISTS (SELECT 1 FROM public.organization_memberships om
                   JOIN public.user_roles ur ON ur.organization_membership_id = om.id
                   JOIN public.roles r ON r.id = ur.role_id
                   WHERE om.user_id = ctx.u AND om.organization_id = ctx.o AND om.status = 'active' AND r.code <> 'FAMILY')
       AND NOT EXISTS (SELECT 1 FROM public.organization_worker_memberships owm
                   JOIN public.workers w ON w.id = owm.worker_id
                   WHERE w.user_id = ctx.u AND owm.organization_id = ctx.o AND owm.status = 'active')
    FROM ctx), false);
$$;

-- ¿El residente es familiar activo de quien llama en la organización actual?
CREATE OR REPLACE FUNCTION public.app_family_has_recipient(p_care_recipient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_relationships fr
    WHERE fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
      AND fr.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND fr.care_recipient_id = p_care_recipient_id AND fr.status = 'active');
$$;

-- ¿El turno es de un familiar de quien llama (directo o de su habitación, como el portal familiar)?
CREATE OR REPLACE FUNCTION public.app_family_recipient_shift(p_shift_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.family_relationships fr
      ON fr.organization_id = s.organization_id AND fr.status = 'active'
     AND fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    WHERE s.id = p_shift_id
      AND s.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND (s.care_recipient_id = fr.care_recipient_id
           OR (s.room_id IS NOT NULL AND s.room_id = public.app_recipient_room_id(fr.care_recipient_id))));
$$;

-- ¿La membresía de empleado atiende a un familiar de quien llama (asignación aceptada en su turno) o registró
-- actividades de su familiar? Solo eso puede ver la familia del personal.
CREATE OR REPLACE FUNCTION public.app_family_visible_membership(p_membership_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.organization_worker_membership_id = p_membership_id
        AND a.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND a.response_status = 'accepted'
        AND public.app_family_recipient_shift(a.shift_id)
        AND (a.care_recipient_id IS NULL OR public.app_family_has_recipient(a.care_recipient_id)))
    OR EXISTS (
      SELECT 1 FROM public.care_events ce
      WHERE ce.organization_worker_membership_id = p_membership_id
        AND ce.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
        AND public.app_family_has_recipient(ce.care_recipient_id));
$$;

CREATE OR REPLACE FUNCTION public.app_family_visible_worker(p_worker_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_worker_memberships owm
    WHERE owm.worker_id = p_worker_id
      AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND public.app_family_visible_membership(owm.id));
$$;

-- Credencial que el portal familiar puede mostrar (auditoría 26-nov): de personal visible con membresía ACTIVA en la
-- organización actual, vigente, activa y APROBADA por esta organización. Igual que lo que devuelve la API
-- (listFamilyShifts); las credenciales son de la persona, así que sin esto se verían las subidas o revisadas solo en
-- otra organización.
CREATE OR REPLACE FUNCTION public.app_family_visible_credential(p_credential_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.credentials c
    JOIN public.organization_worker_memberships owm
      ON owm.worker_id = c.worker_id AND owm.status = 'active'
     AND owm.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    WHERE c.id = p_credential_id
      AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at >= current_date)
      AND public.app_family_visible_membership(owm.id)
      AND EXISTS (SELECT 1 FROM public.organization_credential_reviews ocr
                  WHERE ocr.credential_id = c.id AND ocr.organization_id = owm.organization_id AND ocr.review_status = 'approved'));
$$;

REVOKE ALL ON FUNCTION public.app_family_only_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_family_has_recipient(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_family_recipient_shift(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_family_visible_membership(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_family_visible_worker(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_family_visible_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_family_only_member() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_family_has_recipient(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_family_recipient_shift(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_family_visible_membership(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_family_visible_worker(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_family_visible_credential(uuid) TO app_runtime;

-- Restrictivas (se suman con AND a las existentes); solo actúan sobre el usuario solo-familia.
DROP POLICY IF EXISTS family_scope_own_user ON users;
CREATE POLICY family_scope_own_user ON users AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DROP POLICY IF EXISTS family_scope_shifts ON shifts;
CREATE POLICY family_scope_shifts ON shifts AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR public.app_family_recipient_shift(id));
DROP POLICY IF EXISTS family_scope_assignments ON assignments;
CREATE POLICY family_scope_assignments ON assignments AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member()
         OR (public.app_family_recipient_shift(shift_id) AND (care_recipient_id IS NULL OR public.app_family_has_recipient(care_recipient_id))));
DROP POLICY IF EXISTS family_scope_worker_memberships ON organization_worker_memberships;
CREATE POLICY family_scope_worker_memberships ON organization_worker_memberships AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR public.app_family_visible_membership(id));
DROP POLICY IF EXISTS family_scope_workers ON workers;
CREATE POLICY family_scope_workers ON workers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR public.app_family_visible_worker(id));
DROP POLICY IF EXISTS family_scope_credentials ON credentials;
CREATE POLICY family_scope_credentials ON credentials AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR public.app_family_visible_credential(id));
-- La familia nunca necesita disponibilidad ni autorizaciones por establecimiento del personal.
DROP POLICY IF EXISTS family_scope_deny ON worker_unavailability_periods;
CREATE POLICY family_scope_deny ON worker_unavailability_periods AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_family_only_member());
DROP POLICY IF EXISTS family_scope_deny ON establishment_worker_assignments;
CREATE POLICY family_scope_deny ON establishment_worker_assignments AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_family_only_member());
-- Documentos y archivos profesionales del personal (licencias, certificados): la familia nunca los usa. Los archivos
-- operativos de la organización (fotos de actividades, adjuntos de incidentes) siguen con sus políticas propias.
DROP POLICY IF EXISTS family_scope_deny ON documents;
CREATE POLICY family_scope_deny ON documents AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_family_only_member());
DROP POLICY IF EXISTS family_scope_professional_files ON stored_files;
CREATE POLICY family_scope_professional_files ON stored_files AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_family_only_member() OR scope_type <> 'PLATFORM_PROFESSIONAL');

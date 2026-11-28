-- 177 · Hogares F5: conversación familiar solo con la administración (D5; decisión de Rafa, 26-nov-2026) y conteo
-- agregado de residentes activos para Central, y aislamiento de la familia en la base (RLS). Aditiva y sin datos.
-- 1. Redefine app_worker_messaging_window (132, redefinida en la 176). Fuera de los hogares el
-- cuerpo es idéntico al de la 132: agencias e independientes no cambian. En un hogar la ventana del personal es
-- siempre falsa, así que app_user_can_message_recipient (132) deja la conversación de cada residente a su familia y a
-- la administración (ORGANIZATION_ADMIN y SUPERVISOR); el servicio de mensajes ya no añade personal como participante
-- y threadAccessSql le niega cualquier hilo existente. No modifica shifts ni enciende interruptores.
CREATE OR REPLACE FUNCTION app_worker_messaging_window(
  p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     -- 177 (hogares F5, decisión de Rafa del 26-nov): en un hogar la conversación familiar es SOLO con la
     -- administración (D5). El personal nunca entra por esta ventana, ni por su asignación ni por un turno directo.
     AND NOT public.app_org_is_residential(p_organization_id)
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
     ));
$$;
REVOKE ALL ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) TO app_runtime;

-- 2. Central (plan §2 y D8): conteo de residentes activos únicos de un hogar, sin nombres ni ningún otro dato.
-- platform_phi_deny impide a ETNARA central leer care_recipients; esta función devuelve SOLO un número agregado, solo a
-- ETNARA central (app_is_superadmin) y solo para hogares (NULL en cualquier otro caso). La alerta comercial (pasar de 10,
-- sin bloqueos ni cargos) y la exclusión de Hogar Demo (DEMO_ENVIRONMENT) se deciden en el servicio de Central.
CREATE OR REPLACE FUNCTION public.app_platform_residential_active_residents(p_organization_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN public.app_is_superadmin() AND public.app_org_is_residential(p_organization_id)
    THEN (SELECT count(DISTINCT cr.id)::int FROM public.care_recipients cr
          WHERE cr.organization_id = p_organization_id AND cr.status = 'active' AND cr.archived_at IS NULL)
    ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.app_platform_residential_active_residents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_platform_residential_active_residents(uuid) TO app_runtime;

-- 3. Aislamiento de la familia en hogares, también en la base (D5; autorizado por Rafa el 26-nov-2026).
-- Hallazgo: las políticas existentes dejan a cualquier miembro activo de la organización (también a un familiar) leer
-- con app_runtime directo credenciales, turnos, asignaciones, empleados y sus membresías, contactos de usuarios y la
-- geocerca. La API nunca lo devuelve; ahora la RLS tampoco lo permite en un hogar.
-- «Solo familia» = en la organización actual (un hogar) tiene el rol FAMILY y NINGÚN otro rol de la organización
-- (ORGANIZATION_ADMIN, SUPERVISOR, WORKER) ni una membresía de empleado activa. Quien además es administración o
-- personal conserva sus permisos legítimos; en una agencia o independiente nada cambia (la función es falsa).
CREATE OR REPLACE FUNCTION public.app_residential_family_only()
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
       AND public.app_org_is_residential(ctx.o)
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
REVOKE ALL ON FUNCTION public.app_residential_family_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_residential_family_only() TO app_runtime;

-- Restrictivas: se suman (AND) a las existentes y solo actúan sobre un usuario solo-familia en un hogar.
DROP POLICY IF EXISTS residential_family_deny ON credentials;
CREATE POLICY residential_family_deny ON credentials AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON shifts;
CREATE POLICY residential_family_deny ON shifts AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON assignments;
CREATE POLICY residential_family_deny ON assignments AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON workers;
CREATE POLICY residential_family_deny ON workers AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON organization_worker_memberships;
CREATE POLICY residential_family_deny ON organization_worker_memberships AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON worker_unavailability_periods;
CREATE POLICY residential_family_deny ON worker_unavailability_periods AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON establishment_worker_assignments;
CREATE POLICY residential_family_deny ON establishment_worker_assignments AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON establishment_settings;
CREATE POLICY residential_family_deny ON establishment_settings AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
DROP POLICY IF EXISTS residential_family_deny ON establishment_technical_rooms;
CREATE POLICY residential_family_deny ON establishment_technical_rooms AS RESTRICTIVE FOR ALL TO app_runtime USING (NOT public.app_residential_family_only());
-- Contactos: un usuario solo-familia de un hogar solo ve su propia fila de users (nunca correos o teléfonos ajenos).
DROP POLICY IF EXISTS residential_family_own_user ON users;
CREATE POLICY residential_family_own_user ON users AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_residential_family_only() OR id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- 4. Autor de cada actividad para la familia de un hogar: SOLO nombre y puesto, y solo de quien registró actividades de
-- SU familiar (relación activa con el rol FAMILY), y solo en un hogar (en agencias e independientes no devuelve nada).
-- Sustituye la lectura directa de workers y memberships, que la RLS de
-- arriba cierra para la familia.
CREATE OR REPLACE FUNCTION public.app_family_activity_authors(p_care_recipient_id uuid)
RETURNS TABLE (membership_id uuid, display_name text, internal_role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT owm.id, w.display_name, owm.internal_role
  FROM public.care_events ce
  JOIN public.organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id AND owm.organization_id = ce.organization_id
  JOIN public.workers w ON w.id = owm.worker_id
  WHERE ce.care_recipient_id = p_care_recipient_id
    AND ce.organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND public.app_org_is_residential(ce.organization_id)
    AND NOT public.app_is_superadmin()
    AND EXISTS (
      SELECT 1 FROM public.family_relationships fr
      JOIN public.organization_memberships om ON om.user_id = fr.user_id AND om.organization_id = fr.organization_id AND om.status = 'active'
      JOIN public.user_roles ur ON ur.organization_membership_id = om.id
      JOIN public.roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
      WHERE fr.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND fr.organization_id = ce.organization_id AND fr.care_recipient_id = p_care_recipient_id AND fr.status = 'active');
$$;
REVOKE ALL ON FUNCTION public.app_family_activity_authors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_family_activity_authors(uuid) TO app_runtime;

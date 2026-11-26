-- Reversión de 177 (hogares F5). Ejecutar como propietario de las migraciones, solo con autorización expresa.
-- No hay datos que conservar: restaura EXACTAMENTE app_worker_messaging_window de la 176, quita las políticas y
-- funciones nuevas y deja el esquema como en la 176.
BEGIN;

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
REVOKE ALL ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_worker_messaging_window(uuid, uuid, uuid) TO app_runtime;

DROP FUNCTION IF EXISTS public.app_platform_residential_active_residents(uuid);
DROP POLICY IF EXISTS residential_family_own_user ON users;
DROP POLICY IF EXISTS residential_family_deny ON credentials;
DROP POLICY IF EXISTS residential_family_deny ON shifts;
DROP POLICY IF EXISTS residential_family_deny ON assignments;
DROP POLICY IF EXISTS residential_family_deny ON workers;
DROP POLICY IF EXISTS residential_family_deny ON organization_worker_memberships;
DROP POLICY IF EXISTS residential_family_deny ON worker_unavailability_periods;
DROP POLICY IF EXISTS residential_family_deny ON establishment_worker_assignments;
DROP POLICY IF EXISTS residential_family_deny ON establishment_settings;
DROP POLICY IF EXISTS residential_family_deny ON establishment_technical_rooms;
DROP FUNCTION IF EXISTS public.app_family_activity_authors(uuid);
DROP FUNCTION IF EXISTS public.app_residential_family_only();


DELETE FROM schema_migrations WHERE filename = '177_residential_portals.sql';
COMMIT;

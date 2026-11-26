-- Reversión de 176 (hogares F3). Ejecutar como propietario de las migraciones, solo con autorización expresa.
-- Se NIEGA si existe cualquier asignación de residentes, sustitución o alerta de cobertura: son registros de quién
-- atendió a quién y su auditoría, que no se borran. Sin datos, restaura EXACTAMENTE las funciones compartidas de la 134
-- (acceso a residentes), la 132 (ventana de mensajes) y la 174 (turnos para ponchar), y deja el esquema como en la 175.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shift_resident_assignments) OR EXISTS (SELECT 1 FROM shift_substitutions) OR EXISTS (SELECT 1 FROM shift_coverage_alerts) THEN
    RAISE EXCEPTION 'ROLLBACK_176_REFUSED: hay asignaciones de residentes, sustituciones o alertas de cobertura; revisar antes de revertir';
  END IF;
END;
$$;
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
    );
$function$;


CREATE OR REPLACE FUNCTION app_worker_messaging_window(
  p_user_id uuid, p_organization_id uuid, p_care_recipient_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT public.app_is_superadmin()
     AND EXISTS (
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
     );
$$;

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

DROP POLICY IF EXISTS notifications_insert_shift_substitution ON notifications;
DROP TRIGGER IF EXISTS care_recipients_residential_close_assignments ON care_recipients;
DROP FUNCTION IF EXISTS public.app_residential_substitute_shift(uuid, uuid, uuid, uuid, timestamptz, text, text, boolean, boolean, jsonb, jsonb, boolean, text, text);
DROP FUNCTION IF EXISTS public.app_residential_care_event_window(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_residential_worker_has_recipient(uuid);
DROP FUNCTION IF EXISTS public.app_residential_user_has_recipient_now(uuid, uuid, uuid);
DROP TABLE IF EXISTS shift_coverage_alerts;
DROP TABLE IF EXISTS shift_resident_assignments;
DROP TABLE IF EXISTS shift_substitutions;
DROP FUNCTION IF EXISTS public.app_residential_close_resident_assignments();
DROP FUNCTION IF EXISTS public.app_residential_coverage_alert_guard();
DROP FUNCTION IF EXISTS public.app_residential_substitution_guard();
DROP FUNCTION IF EXISTS public.app_residential_assignment_guard();
DROP FUNCTION IF EXISTS public.app_residential_membership_busy(uuid, timestamptz, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.app_residential_coverage_bounds(uuid, uuid);
DELETE FROM schema_migrations WHERE filename = '176_residential_resident_assignments.sql';
COMMIT;

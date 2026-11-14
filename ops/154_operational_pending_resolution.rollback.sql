-- Reversión de 154 (deja el esquema igual que antes de 154: 150 en main, o 153 con la serie de contratos).
-- Se NIEGA si 154 ya guardó información (cierres de turnos, autorizaciones de cierre de incidentes
-- graves o incidentes resueltos con responsable/fecha): revertir la borraría. En ese caso, exportar
-- primero esas filas y decidir por escrito.
-- Efecto si procede: vuelve la guarda de turnos de 107 (sin la exigencia de registro de entrada),
-- desaparecen las guardas de incidentes y la auditoría de correcciones. Turnos, asignaciones,
-- registros de verificación, horas, incidentes y su seguimiento quedan intactos.
-- Las filas de audit_log escritas por 154 se conservan (historial).
-- Ejecutar como propietario de las migraciones, en una transacción.
BEGIN;
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM shift_attention_closures)
     OR EXISTS (SELECT 1 FROM incident_closure_authorizers)
     OR EXISTS (SELECT 1 FROM incidents WHERE resolved_by_user_id IS NOT NULL OR resolved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_154_REFUSED_DATA_PRESENT';
  END IF;
END
$chk$;

DROP TRIGGER IF EXISTS incidents_status_audit ON incidents;
DROP TRIGGER IF EXISTS incidents_guard ON incidents;
DROP TRIGGER IF EXISTS verification_events_closure_audit ON verification_events;
DROP TRIGGER IF EXISTS verification_overrides_audit ON verification_overrides;

-- Guarda de turnos: cuerpo literal de 107.
CREATE OR REPLACE FUNCTION app_shift_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Status: a cancelled shift never comes back (it could revive a cancelled
  -- SmartMatch link, journey and alerts); a completed one only re-opens through a
  -- check-in (several caregivers on one shift).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'SHIFT_STATUS_CANCELLED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
      RAISE EXCEPTION 'SHIFT_STATUS_COMPLETED_IS_FINAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Non-managers (caregivers) may only change the status.
  IF current_user = 'app_runtime' AND NOT public.app_is_org_manager() AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.care_recipient_id IS DISTINCT FROM OLD.care_recipient_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.service_location_id IS DISTINCT FROM OLD.service_location_id
    OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
    OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'SHIFT_FIELDS_LOCKED' USING ERRCODE = '42501';
  END IF;
  -- Once the caregiver declared the departure or arrived, the visit cannot be
  -- moved (a stale «En camino» would be shown and alerts suppressed): cancel it
  -- and create a new one instead.
  IF (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end)
     AND (EXISTS (SELECT 1 FROM public.shift_journey_events e WHERE e.shift_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.shift_arrivals a WHERE a.shift_id = OLD.id)) THEN
    RAISE EXCEPTION 'SHIFT_SCHEDULE_LOCKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE IF EXISTS incident_closure_authorizers;
DROP TABLE IF EXISTS shift_attention_closures;
DROP TABLE IF EXISTS operational_pending_activation;
ALTER TABLE incidents DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE incidents DROP COLUMN IF EXISTS resolved_by_user_id;

DROP FUNCTION IF EXISTS app_incident_status_audit();
DROP FUNCTION IF EXISTS app_incident_guard();
DROP FUNCTION IF EXISTS app_incident_has_documented_follow_up(uuid);
DROP FUNCTION IF EXISTS app_can_close_serious_incidents();
DROP FUNCTION IF EXISTS app_incident_closure_authorizers_audit();
DROP FUNCTION IF EXISTS app_incident_closure_authorizers_guard();
DROP FUNCTION IF EXISTS app_incident_is_serious(text);
DROP FUNCTION IF EXISTS app_check_in_after_closure_audit();
DROP FUNCTION IF EXISTS app_verification_override_audit();
DROP FUNCTION IF EXISTS app_rectify_shift_closure(uuid, text);
DROP FUNCTION IF EXISTS app_close_shift_without_service(uuid, text, text);
DROP FUNCTION IF EXISTS app_shift_has_check_in(uuid);
DROP FUNCTION IF EXISTS app_shift_attention_closures_guard();
DROP FUNCTION IF EXISTS app_operational_pending_activation_guard();
DELETE FROM schema_migrations WHERE filename = '154_operational_pending_resolution.sql';
COMMIT;

-- 164 · Cuidador independiente, Fase 1 (25-nov-2026). Solo afecta a organizaciones INDEPENDENT_PROVIDER.
-- Agencias y hogares no cambian: cada regla empieza comprobando app_org_is_independent().
--
--   1. Sin avisos a sí misma: en una práctica, los avisos de gestión y de turno cuyo destinatario es la propia
--      persona que opera la práctica (ORGANIZATION_ADMIN + WORKER) no se crean. Los avisos a la familia, los
--      mensajes, las solicitudes de la familia y los vencimientos de sus documentos siguen igual.
--   2. La invitación de administración dice si es de una práctica (para pedir el nombre profesional al activar).
--
-- Las llegadas NO se modifican: una llegada lejos o sin ubicación conserva needs_review, su proximidad y queda sin
-- revisar (nunca aparece como verificada). En una práctica nadie la «aprueba»: el backend rechaza la revisión
-- (ARRIVAL_REVIEW_NOT_APPLICABLE) y el aviso de revisión a la propia persona no se crea (punto 1).
--
-- Sin tablas nuevas, sin cambios de datos existentes. Idempotente. Reversión: ops/164_independent_practice_phase1.rollback.sql
-- 1. Avisos a sí misma ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_notification_independent_self_filter()
RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS NOT NULL
     AND NEW.notification_type IN (
       'SHIFT_ASSIGNMENT_PENDING', 'SHIFT_ASSIGNMENT_ACCEPTED', 'SHIFT_ASSIGNMENT_REJECTED',
       'SHIFT_STARTED', 'SHIFT_COMPLETED', 'SHIFT_CANCELLED', 'SHIFT_UNASSIGNED', 'SHIFT_RESCHEDULED',
       'SHIFT_LOCATION_CHANGED', 'SHIFT_NOT_EN_ROUTE', 'SHIFT_DELAY_REPORTED', 'SHIFT_LATE_ARRIVAL',
       'SHIFT_ARRIVAL_NEEDS_REVIEW', 'TIMESHEET_NEEDS_REVIEW', 'NEW_INCIDENT', 'NEW_CARE_EVENT',
       'CREDENTIAL_REVIEW_PENDING', 'SHIFT_REPORT_READY', 'OPEN_SHIFT_OFFER')
     AND public.app_org_is_independent(NEW.organization_id)
     AND EXISTS (
       SELECT 1
       FROM public.organization_memberships om
       JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
       JOIN public.roles r ON r.id = ur.role_id
       WHERE om.organization_id = NEW.organization_id AND om.user_id = NEW.user_id
         AND r.code IN ('ORGANIZATION_ADMIN', 'WORKER'))
  THEN
    RETURN NULL; -- la propia persona: no se crea (tampoco su push, que sale de AFTER INSERT)
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_notification_independent_self_filter() FROM PUBLIC;

DROP TRIGGER IF EXISTS notifications_independent_self_filter ON notifications;
CREATE TRIGGER notifications_independent_self_filter BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION app_notification_independent_self_filter();

-- 2. ¿La invitación de administración es de una práctica? ----------------------------------------------------------
-- Solo con el token (hash) de una invitación de administración pendiente y vigente; no revela nada más.
CREATE OR REPLACE FUNCTION app_org_admin_invitation_is_independent(p_token_hash text)
RETURNS boolean AS $$
  SELECT COALESCE((
    SELECT o.organization_type = 'INDEPENDENT_PROVIDER'
    FROM public.access_invitations ai
    JOIN public.organizations o ON o.id = ai.organization_id
    WHERE ai.token_hash = p_token_hash AND ai.invitation_type = 'organization_admin'
      AND ai.status = 'pending' AND ai.expires_at > now()
    LIMIT 1), false);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app_org_admin_invitation_is_independent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_org_admin_invitation_is_independent(text) TO app_runtime;


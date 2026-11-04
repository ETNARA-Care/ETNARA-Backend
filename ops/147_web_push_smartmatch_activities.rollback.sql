-- Reversión de 147 (push de SmartMatch, actividades y fin de visita). Superusuario de migraciones.
-- Deja el catálogo y app_push_resolve exactamente como en 146. Las suscripciones no cambian.
BEGIN;
DELETE FROM push_deliveries d USING notifications n
 WHERE n.id = d.notification_id AND d.state IN ('pending', 'sending')
   AND n.notification_type IN ('SMARTMATCH_APPLICATION_SUBMITTED','SMARTMATCH_APPLICATION_APPROVED','SMARTMATCH_APPLICATION_REJECTED',
     'SMARTMATCH_APPLICATION_CLOSED','SMARTMATCH_OPPORTUNITY_CANCELLED','SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED',
     'SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED','NEW_CARE_EVENT','SHIFT_COMPLETED');
DELETE FROM push_notification_catalog WHERE (notification_type, audience) IN (
  ('SMARTMATCH_APPLICATION_SUBMITTED','agency'), ('SMARTMATCH_APPLICATION_APPROVED','applicant'),
  ('SMARTMATCH_APPLICATION_REJECTED','applicant'), ('SMARTMATCH_APPLICATION_CLOSED','applicant'),
  ('SMARTMATCH_OPPORTUNITY_CANCELLED','applicant'), ('SMARTMATCH_APPLICATION_OPPORTUNITY_CANCELLED','applicant'),
  ('SMARTMATCH_APPLICATION_OPPORTUNITY_EXPIRED','applicant'), ('NEW_CARE_EVENT','family'),
  ('SHIFT_COMPLETED','family'), ('SHIFT_COMPLETED','agency'));
ALTER TABLE push_notification_catalog DROP CONSTRAINT IF EXISTS push_notification_catalog_audience_check;
ALTER TABLE push_notification_catalog ADD CONSTRAINT push_notification_catalog_audience_check
  CHECK (audience IN ('agency', 'caregiver', 'family', 'self'));
CREATE OR REPLACE FUNCTION public.app_push_resolve(p_notification uuid, p_for_open boolean DEFAULT false)
RETURNS TABLE (reason text, audience text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  n record; pref record; v_local time; v_admin boolean := false; v_staff boolean := false;
  v_caregiver boolean := false; v_family boolean := false; v_aud text;
BEGIN
  SELECT x.id, x.user_id, x.organization_id, x.notification_type, x.care_recipient_id, x.related_entity_id INTO n
    FROM public.notifications x WHERE x.id = p_notification;
  IF n.id IS NULL
     OR (NULLIF(current_setting('app.current_user_id', true), '') IS NOT NULL
         AND n.user_id <> NULLIF(current_setting('app.current_user_id', true), '')::uuid) THEN
    RETURN QUERY SELECT 'NOTIFICATION_GONE'::text, NULL::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_notification_catalog c WHERE c.notification_type = n.notification_type) THEN
    RETURN QUERY SELECT 'TYPE_NOT_ALLOWED'::text, NULL::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = n.user_id AND u.status = 'active') THEN
    RETURN QUERY SELECT 'USER_INACTIVE'::text, NULL::text; RETURN;
  END IF;

  IF n.organization_id IS NULL THEN
    -- Solo la prueba propia vive fuera de una agencia.
    IF NOT EXISTS (SELECT 1 FROM public.push_notification_catalog c WHERE c.notification_type = n.notification_type AND c.audience = 'self') THEN
      RETURN QUERY SELECT 'NO_ORGANIZATION'::text, NULL::text; RETURN;
    END IF;
    IF NOT public.app_push_user_has_access(n.user_id) THEN RETURN QUERY SELECT 'NO_ACTIVE_ACCESS'::text, 'self'::text; RETURN; END IF;
    RETURN QUERY SELECT NULL::text, 'self'::text; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = n.organization_id
                  AND o.status IN ('active', 'trial') AND o.archived_at IS NULL) THEN
    RETURN QUERY SELECT 'ORGANIZATION_INACTIVE'::text, NULL::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_memberships om WHERE om.user_id = n.user_id
                  AND om.organization_id = n.organization_id AND om.status = 'active') THEN
    RETURN QUERY SELECT 'NO_ACTIVE_MEMBERSHIP'::text, NULL::text; RETURN;
  END IF;

  SELECT coalesce(bool_or(r.code = 'ORGANIZATION_ADMIN'), false), coalesce(bool_or(r.code = 'SUPERVISOR'), false)
    INTO v_admin, v_staff
    FROM public.organization_memberships om
    JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
    JOIN public.roles r ON r.id = ur.role_id
   WHERE om.user_id = n.user_id AND om.organization_id = n.organization_id AND om.status = 'active';
  v_caregiver := EXISTS (SELECT 1 FROM public.workers w
                           JOIN public.organization_worker_memberships owm ON owm.worker_id = w.id
                          WHERE w.user_id = n.user_id AND owm.organization_id = n.organization_id AND owm.status = 'active');
  -- Familia: relación activa con avisos permitidos y rol FAMILY; si el aviso es de un
  -- residente, la relación debe ser con ESE residente.
  v_family := EXISTS (SELECT 1 FROM public.family_relationships fr
                       WHERE fr.user_id = n.user_id AND fr.organization_id = n.organization_id
                         AND fr.status = 'active' AND fr.can_receive_notifications = true
                         AND (n.care_recipient_id IS NULL OR fr.care_recipient_id = n.care_recipient_id))
              AND EXISTS (SELECT 1 FROM public.organization_memberships om
                            JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
                            JOIN public.roles r ON r.id = ur.role_id AND r.code = 'FAMILY'
                           WHERE om.user_id = n.user_id AND om.organization_id = n.organization_id AND om.status = 'active');

  -- Primer público que la persona cumple Y que tiene texto para este tipo.
  SELECT c.audience INTO v_aud FROM public.push_notification_catalog c
   WHERE c.notification_type = n.notification_type
     AND ((c.audience = 'agency' AND (v_admin OR v_staff)) OR (c.audience = 'caregiver' AND v_caregiver) OR (c.audience = 'family' AND v_family))
   ORDER BY CASE c.audience WHEN 'agency' THEN 1 WHEN 'caregiver' THEN 2 ELSE 3 END LIMIT 1;
  IF v_aud IS NULL THEN RETURN QUERY SELECT 'NOT_FOR_THIS_ROLE'::text, NULL::text; RETURN; END IF;

  -- A partir de aquí, motivos que impiden ENVIAR pero no ABRIR un aviso que ya está en la bandeja.
  IF p_for_open THEN RETURN QUERY SELECT NULL::text, v_aud; RETURN; END IF;

  IF NOT public.app_org_feature_enabled(n.organization_id, 'PUSH_NOTIFICATIONS') THEN
    RETURN QUERY SELECT 'FEATURE_OFF'::text, v_aud; RETURN;
  END IF;
  SELECT * INTO pref FROM public.push_preferences WHERE user_id = n.user_id;
  IF v_aud = 'agency' THEN
    IF v_admin THEN
      IF pref.agency_alerts IS FALSE THEN RETURN QUERY SELECT 'AGENCY_ALERTS_OFF'::text, v_aud; RETURN; END IF;
    ELSIF pref.agency_alerts IS NOT TRUE THEN
      RETURN QUERY SELECT 'SUPERVISOR_NOT_OPTED_IN'::text, v_aud; RETURN;
    END IF;
  END IF;
  -- Familia: una sola llegada por visita (SHIFT_STARTED y FAMILY_CAREGIVER_ARRIVED).
  IF v_aud = 'family' AND n.notification_type IN ('SHIFT_STARTED', 'FAMILY_CAREGIVER_ARRIVED') AND EXISTS (
       SELECT 1 FROM public.notifications o JOIN public.push_outbox ob ON ob.notification_id = o.id AND ob.state = 'expanded'
        WHERE o.user_id = n.user_id AND o.id <> n.id AND o.related_entity_id = n.related_entity_id
          AND o.notification_type IN ('SHIFT_STARTED', 'FAMILY_CAREGIVER_ARRIVED')
          AND o.created_at > now() - interval '12 hours') THEN
    RETURN QUERY SELECT 'DUPLICATE_ARRIVAL'::text, v_aud; RETURN;
  END IF;
  -- Silencio nocturno: el aviso queda en la bandeja; el teléfono no suena.
  IF coalesce(pref.quiet_enabled, false) THEN
    v_local := (now() AT TIME ZONE pref.time_zone)::time;
    IF (pref.quiet_start < pref.quiet_end AND v_local >= pref.quiet_start AND v_local < pref.quiet_end)
       OR (pref.quiet_start > pref.quiet_end AND (v_local >= pref.quiet_start OR v_local < pref.quiet_end)) THEN
      RETURN QUERY SELECT 'QUIET_HOURS'::text, v_aud; RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT NULL::text, v_aud;
END $$;

REVOKE ALL ON FUNCTION public.app_push_resolve(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_push_resolve(uuid, boolean) TO app_runtime;
DROP FUNCTION IF EXISTS public.app_push_in_quiet_hours(uuid);
COMMIT;

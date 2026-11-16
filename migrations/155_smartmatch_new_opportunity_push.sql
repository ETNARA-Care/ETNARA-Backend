-- 155 (16-nov-2026): SmartMatch · aviso «Hay una nueva oportunidad en SmartMatch».
--
-- Al PUBLICAR una oportunidad interna, cada cuidador activo de ESA agencia (rol WORKER y
-- membresía de trabajador activa: las mismas personas que hoy la ven en «Disponibles")
-- recibe un aviso en la campana y, si activó el teléfono, un push.
--  - Texto fijo y general: ni municipio, ni horario, ni persona atendida, ni dirección.
--  - Solo si la agencia tiene SMARTMATCH (al publicar) y PUSH_NOTIFICATIONS (al enviar, 146).
--  - Respeta el silencio nocturno de cada persona (146/147): la campana sí lo recibe.
--  - Un aviso por persona y oportunidad (índice único).
--  - Sin ráfagas: como máximo un push de este tipo cada 30 min por persona y agencia; los
--    demás quedan solo en la campana.
--  - Al cubrirse, cancelarse o vencer la oportunidad, los avisos sin leer se marcan leídos y
--    los push aún no enviados se descartan.
--  - Nunca a otras agencias (la red entre agencias sigue bloqueada, 095) ni a ETNARA Central.
-- Solo añade una fila al catálogo, un índice, dos funciones y un trigger. No cambia datos.
-- Reversión: ops/155_smartmatch_new_opportunity_push.rollback.sql.

INSERT INTO push_notification_catalog (notification_type, audience, title, body, ttl_seconds, urgency) VALUES
  ('SMARTMATCH_OPPORTUNITY_PUBLISHED', 'caregiver', 'ETNARA Care', 'Hay una nueva oportunidad en SmartMatch', 21600, 'normal')
ON CONFLICT (notification_type, audience) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_smartmatch_published_once
  ON notifications (user_id, related_entity_id)
  WHERE notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED';

CREATE OR REPLACE FUNCTION public.app_smartmatch_opportunity_publish_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_ids uuid[];
BEGIN
  -- Publicada ahora (y aún abierta): aviso a los cuidadores activos de la agencia.
  IF NEW.status = 'PUBLISHED' AND OLD.status IS DISTINCT FROM 'PUBLISHED'
     AND NEW.visibility = 'INTERNAL' AND NEW.starts_at > now()
     AND public.app_org_feature_enabled(NEW.organization_id, 'SMARTMATCH') THEN
    WITH ins AS (
      INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type,
                                        related_entity_id, channel, status, sent_at)
      SELECT DISTINCT om.user_id, NEW.organization_id, 'SMARTMATCH_OPPORTUNITY_PUBLISHED',
             'smartmatch_opportunity', NEW.id, 'in_app', 'sent', now()
        FROM public.organization_memberships om
        JOIN public.user_roles ur ON ur.organization_membership_id = om.id AND ur.organization_id = om.organization_id
        JOIN public.roles r ON r.id = ur.role_id AND r.code = 'WORKER'
        JOIN public.users u ON u.id = om.user_id AND u.status = 'active'
       WHERE om.organization_id = NEW.organization_id AND om.status = 'active'
         AND EXISTS (SELECT 1 FROM public.workers w
                       JOIN public.organization_worker_memberships owm ON owm.worker_id = w.id
                      WHERE w.user_id = om.user_id AND owm.organization_id = NEW.organization_id AND owm.status = 'active')
      ON CONFLICT DO NOTHING
      RETURNING id, user_id)
    SELECT array_agg(id) INTO v_ids FROM ins;

    -- Sin ráfagas: si la persona ya tiene un push de este tipo en cola o enviado en los
    -- últimos 30 min en esta agencia, este queda solo en la campana.
    IF v_ids IS NOT NULL THEN
      UPDATE public.push_outbox ob
         SET state = 'skipped', reason = 'OPPORTUNITY_THROTTLED', processed_at = now()
        FROM public.notifications n
       WHERE ob.notification_id = n.id AND n.id = ANY (v_ids) AND ob.state = 'pending'
         AND EXISTS (SELECT 1 FROM public.notifications o
                       JOIN public.push_outbox prev ON prev.notification_id = o.id AND prev.state IN ('pending', 'expanded')
                      WHERE o.user_id = n.user_id AND o.organization_id = n.organization_id
                        AND o.notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED'
                        AND NOT (o.id = ANY (v_ids))
                        AND o.created_at > now() - interval '30 minutes');
    END IF;
  END IF;

  -- Ya no está abierta (cubierta, cancelada o vencida): el aviso deja de ser útil.
  IF OLD.status = 'PUBLISHED' AND NEW.status IS DISTINCT FROM 'PUBLISHED' THEN
    UPDATE public.notifications SET read_at = now()
     WHERE notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED' AND related_entity_id = NEW.id
       AND organization_id = NEW.organization_id AND read_at IS NULL;
    UPDATE public.push_outbox ob SET state = 'skipped', reason = 'OPPORTUNITY_CLOSED', processed_at = now()
      FROM public.notifications n
     WHERE ob.notification_id = n.id AND ob.state = 'pending'
       AND n.notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED' AND n.related_entity_id = NEW.id;
    UPDATE public.push_deliveries d SET state = 'skipped', reason = 'OPPORTUNITY_CLOSED', updated_at = now()
      FROM public.notifications n
     WHERE d.notification_id = n.id AND d.state = 'pending'
       AND n.notification_type = 'SMARTMATCH_OPPORTUNITY_PUBLISHED' AND n.related_entity_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.app_smartmatch_opportunity_publish_notify() FROM PUBLIC;

DROP TRIGGER IF EXISTS smartmatch_opportunity_publish_notify ON smartmatch_opportunities;
CREATE TRIGGER smartmatch_opportunity_publish_notify
  AFTER UPDATE OF status ON smartmatch_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.app_smartmatch_opportunity_publish_notify();

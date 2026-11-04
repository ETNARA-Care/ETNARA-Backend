-- Web Push (4-nov-2026): avisos en el teléfono para la PWA, sin App Store ni Google Play.
--
-- Decisiones aprobadas por Rafa (4-nov):
--  1. Incidentes a familias: SOLO en la bandeja (nunca por push). Las comunicaciones
--     importantes a familias llegarán más adelante como «aviso autorizado» por la agencia.
--  2. Agencia: administradoras por defecto; supervisoras solo si lo activan en sus
--     preferencias (el aviso en la bandeja ya respeta sus permisos).
--  3. Silencio nocturno configurable por usuario: no se envía el push, la bandeja no cambia.
--  4. Agencia suspendida o archivada: se revocan las suscripciones vinculadas a ella, con
--     registro de auditoría (conteos, nunca el endpoint).
--  5. Al abrir un aviso se puede pedir iniciar sesión de nuevo (sin Face ID por ahora).
--
-- Reglas de privacidad:
--  - El texto del push sale SOLO de push_notification_catalog (lista cerrada y fija):
--    título «ETNARA Care» y una frase genérica. Nunca nombres, residentes, direcciones,
--    diagnósticos, horas ni el nombre de la agencia. Un tipo fuera del catálogo no se envía.
--  - El contenido cifrado (RFC 8291) solo lleva el texto y un enlace /abrir?n=<id del aviso>.
--    El destino se calcula en el servidor, con sesión, al abrirlo.
--  - Antes de CADA envío se comprueban de nuevo: usuario activo, agencia
--    activa y no archivada, función PUSH_NOTIFICATIONS encendida, rol o relación vigente,
--    permiso de avisos del familiar y silencio nocturno.
--  - ETNARA Central no tiene acceso a suscripciones, preferencias ni entregas.
--
-- Solo añade: tablas nuevas, funciones nuevas, dos disparadores y el código de función
-- PUSH_NOTIFICATIONS (apagado para todas las agencias). Nada existente cambia de
-- comportamiento. Reversión: ops/146_web_push_notifications.rollback.sql.

-- ------------------------------------------------------------ función por agencia
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_feature_code_check;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS'));
ALTER TABLE organization_feature_events DROP CONSTRAINT IF EXISTS organization_feature_events_feature_code_check;
ALTER TABLE organization_feature_events ADD CONSTRAINT organization_feature_events_feature_code_check
  CHECK (feature_code IN ('SMARTMATCH', 'EN_CAMINO', 'ACTIVITY_PHOTOS', 'FINANZAS', 'FACTURACION', 'SHIFT_REPORTS', 'PUSH_NOTIFICATIONS'));

-- ------------------------------------------------------------ catálogo cerrado
-- Un texto por (tipo, público): el mismo aviso puede llegar a la agencia y a la familia con
-- frases distintas. Si no hay fila para el público de quien lo recibe, NO se envía por push.
CREATE TABLE IF NOT EXISTS push_notification_catalog (
  notification_type text NOT NULL,
  audience          text NOT NULL CHECK (audience IN ('agency', 'caregiver', 'family', 'self')),
  title             text NOT NULL CHECK (title = 'ETNARA Care'),
  body              text NOT NULL CHECK (length(body) BETWEEN 5 AND 80 AND body !~ '[0-9{}<>@/]'),
  ttl_seconds       integer NOT NULL CHECK (ttl_seconds BETWEEN 60 AND 86400),
  urgency           text NOT NULL CHECK (urgency IN ('normal', 'high')),
  PRIMARY KEY (notification_type, audience)
);

INSERT INTO push_notification_catalog (notification_type, audience, title, body, ttl_seconds, urgency) VALUES
  -- Agencia
  ('SHIFT_ASSIGNMENT_ACCEPTED',  'agency',    'ETNARA Care', 'Una cuidadora aceptó un turno',                       21600, 'normal'),
  ('SHIFT_ASSIGNMENT_REJECTED',  'agency',    'ETNARA Care', 'Una cuidadora rechazó un turno',                      21600, 'high'),
  ('SHIFT_STARTED',              'agency',    'ETNARA Care', 'Se registró una llegada a un turno',                   3600, 'normal'),
  ('SHIFT_ARRIVAL_NEEDS_REVIEW', 'agency',    'ETNARA Care', 'Una llegada necesita revisión',                        7200, 'normal'),
  ('SHIFT_NOT_EN_ROUTE',         'agency',    'ETNARA Care', 'Un turno empieza pronto sin salida registrada',        1800, 'high'),
  ('SHIFT_DELAY_REPORTED',       'agency',    'ETNARA Care', 'Se informó un retraso en un turno',                    3600, 'high'),
  ('SHIFT_LATE_ARRIVAL',         'agency',    'ETNARA Care', 'Un turno no tiene llegada registrada',                 3600, 'high'),
  ('NEW_INCIDENT',               'agency',    'ETNARA Care', 'Se registró un incidente nuevo',                       21600, 'high'),
  -- Cuidadora
  ('SHIFT_ASSIGNMENT_PENDING',   'caregiver', 'ETNARA Care', 'Tienes un turno nuevo pendiente de respuesta',        43200, 'normal'),
  ('SHIFT_RESCHEDULED',          'caregiver', 'ETNARA Care', 'Cambió el horario de uno de tus turnos',              43200, 'high'),
  ('SHIFT_LOCATION_CHANGED',     'caregiver', 'ETNARA Care', 'Cambió la dirección de uno de tus turnos',            43200, 'high'),
  ('SHIFT_CANCELLED',            'caregiver', 'ETNARA Care', 'Se canceló uno de tus turnos',                        43200, 'high'),
  ('SHIFT_UNASSIGNED',           'caregiver', 'ETNARA Care', 'Ya no tienes asignado un turno',                      43200, 'high'),
  -- Familia (NEW_INCIDENT nunca: decisión 1). SHIFT_STARTED es la llegada cuando la agencia
  -- no usa «En camino»; si también llega FAMILY_CAREGIVER_ARRIVED, solo suena una vez.
  ('SHIFT_STARTED',              'family',    'ETNARA Care', 'La cuidadora llegó',                                   3600, 'normal'),
  ('FAMILY_CAREGIVER_ARRIVED',   'family',    'ETNARA Care', 'La cuidadora llegó',                                   3600, 'normal'),
  ('FAMILY_CAREGIVER_DELAYED',   'family',    'ETNARA Care', 'La cuidadora informó un retraso',                      3600, 'normal'),
  ('FAMILY_VISIT_CANCELLED',     'family',    'ETNARA Care', 'La agencia canceló una visita',                        21600, 'normal'),
  ('FAMILY_CAREGIVER_CHANGED',   'family',    'ETNARA Care', 'Cambió la cuidadora de una visita',                    21600, 'normal'),
  ('NEW_MESSAGE',                'family',    'ETNARA Care', 'Tienes un mensaje nuevo',                              21600, 'normal'),
  -- Prueba pedida por la propia persona desde Ajustes
  ('PUSH_TEST',                  'self',      'ETNARA Care', 'Las notificaciones están activadas en este teléfono',    600, 'normal')
ON CONFLICT (notification_type, audience) DO NOTHING;

ALTER TABLE push_notification_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notification_catalog FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------ suscripciones (una por navegador/teléfono)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Sesión con la que se activó. Que la sesión VENZA no apaga el teléfono (los avisos deben
  -- llegar con la app cerrada; al abrir uno se pide iniciar sesión: decisión 5). Cerrar sesión
  -- o cambiar la contraseña (revocación) sí lo borra.
  session_id       uuid NULL REFERENCES sessions(id) ON DELETE SET NULL,
  endpoint         text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 1024 AND endpoint ~ '^https://'),
  p256dh           text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),
  auth             text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{22,24}={0,2}$'),
  device_label     text NULL CHECK (device_label IS NULL OR length(device_label) <= 60),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz NULL,
  failure_count    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions (session_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
-- La persona ve y borra solo las suyas. El alta pasa por app_push_register (valida todo).
GRANT SELECT, DELETE ON push_subscriptions TO app_runtime;
DROP POLICY IF EXISTS push_subscriptions_owner_read ON push_subscriptions;
CREATE POLICY push_subscriptions_owner_read ON push_subscriptions FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DROP POLICY IF EXISTS push_subscriptions_owner_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_owner_delete ON push_subscriptions FOR DELETE
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_phi_deny ON push_subscriptions;
CREATE POLICY platform_phi_deny ON push_subscriptions AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_is_superadmin()) WITH CHECK (NOT public.app_is_superadmin());

-- ------------------------------------------------------------ preferencias
CREATE TABLE IF NOT EXISTS push_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quiet_enabled  boolean NOT NULL DEFAULT false,
  quiet_start    time NOT NULL DEFAULT '22:00',
  quiet_end      time NOT NULL DEFAULT '07:00',
  time_zone      text NOT NULL DEFAULT 'America/Puerto_Rico' CHECK (time_zone IN ('America/Puerto_Rico', 'America/New_York')),
  -- NULL = según el rol (administradora sí, supervisora no). true/false = decisión de la persona.
  agency_alerts  boolean NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (quiet_start <> quiet_end)
);
ALTER TABLE push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_preferences FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON push_preferences TO app_runtime;
DROP POLICY IF EXISTS push_preferences_owner ON push_preferences;
CREATE POLICY push_preferences_owner ON push_preferences FOR ALL
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
DROP POLICY IF EXISTS platform_phi_deny ON push_preferences;
CREATE POLICY platform_phi_deny ON push_preferences AS RESTRICTIVE FOR ALL TO app_runtime
  USING (NOT public.app_is_superadmin()) WITH CHECK (NOT public.app_is_superadmin());

-- ------------------------------------------------------------ cola y entregas (sin contenido)
CREATE TABLE IF NOT EXISTS push_outbox (
  notification_id uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'expanded', 'skipped')),
  reason          text NULL,
  processed_at    timestamptz NULL
);
CREATE INDEX IF NOT EXISTS idx_push_outbox_pending ON push_outbox (created_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS push_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state            text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'expired')),
  reason           text NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz NULL,
  last_status      integer NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_due ON push_deliveries (next_attempt_at) WHERE state IN ('pending', 'sending');

-- Auditoría: conteos y motivos, nunca el endpoint ni las claves.
CREATE TABLE IF NOT EXISTS push_subscription_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  organization_id  uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,
  event            text NOT NULL CHECK (event IN ('registered', 'removed')),
  reason           text NOT NULL CHECK (reason ~ '^[A-Z_]{3,40}$'),
  subscription_count integer NOT NULL DEFAULT 1 CHECK (subscription_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscription_events_org ON push_subscription_events (organization_id, created_at);

-- Sin acceso directo de app_runtime: solo las funciones de abajo las tocan.
ALTER TABLE push_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE push_subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscription_events FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------ reglas de acceso (una sola fuente)

/** true si la persona tiene ALGÚN acceso vigente que pueda recibir avisos (para el alta). */
CREATE OR REPLACE FUNCTION public.app_push_user_has_access(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_memberships om
      JOIN public.organizations o ON o.id = om.organization_id
      JOIN public.users u ON u.id = om.user_id
     WHERE om.user_id = p_user AND om.status = 'active' AND u.status = 'active'
       AND o.status IN ('active', 'trial') AND o.archived_at IS NULL);
$$;

/**
 * Público de quien recibe este aviso (agency, caregiver, family o self) y, si no se puede
 * enviar ahora, el motivo. reason NULL = se puede enviar. Se evalúa al encolar, al preparar
 * cada entrega y otra vez en cada reintento. Con contexto de petición solo responde sobre
 * avisos de esa misma persona.
 */
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

-- ------------------------------------------------------------ alta, baja y prueba (con sesión)

/**
 * Alta de la suscripción de ESTE navegador para la persona de la sesión. Reglas:
 *  - la sesión debe ser suya y vigente; se necesita algún acceso activo (Central no);
 *  - solo servicios push conocidos (evita que el servidor llame a direcciones arbitrarias);
 *  - si el mismo endpoint estaba con otra persona o sesión (teléfono compartido), se mueve;
 *  - como máximo 10 por persona: se descarta la más antigua.
 */
CREATE OR REPLACE FUNCTION public.app_push_register(p_session uuid, p_endpoint text, p_p256dh text, p_auth text, p_label text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  v_prev record; v_id uuid; v_over integer;
BEGIN
  IF v_user IS NULL OR public.app_is_superadmin() THEN RAISE EXCEPTION 'PUSH_NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = p_session AND s.user_id = v_user
                  AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
    RAISE EXCEPTION 'PUSH_SESSION_INVALID' USING ERRCODE = '42501';
  END IF;
  IF NOT public.app_push_user_has_access(v_user) THEN RAISE EXCEPTION 'PUSH_NO_ACTIVE_ACCESS' USING ERRCODE = '42501'; END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://(fcm\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/[A-Za-z0-9_:./%=+?&-]+$' THEN
    RAISE EXCEPTION 'PUSH_ENDPOINT_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;

  SELECT id, user_id, session_id INTO v_prev FROM public.push_subscriptions WHERE endpoint = p_endpoint;
  IF v_prev.id IS NOT NULL AND v_prev.user_id = v_user THEN
    UPDATE public.push_subscriptions
       SET session_id = p_session, p256dh = p_p256dh, auth = p_auth, device_label = NULLIF(btrim(p_label), ''),
           last_seen_at = now(), failure_count = 0
     WHERE id = v_prev.id;
    RETURN v_prev.id;
  END IF;
  IF v_prev.id IS NOT NULL THEN
    DELETE FROM public.push_subscriptions WHERE id = v_prev.id;
    INSERT INTO public.push_subscription_events (user_id, event, reason) VALUES (v_prev.user_id, 'removed', 'DEVICE_REASSIGNED');
  END IF;

  INSERT INTO public.push_subscriptions (user_id, session_id, endpoint, p256dh, auth, device_label)
  VALUES (v_user, p_session, p_endpoint, p_p256dh, p_auth, NULLIF(btrim(p_label), ''))
  RETURNING id INTO v_id;
  INSERT INTO public.push_subscription_events (user_id, event, reason) VALUES (v_user, 'registered', 'USER_ENABLED');

  WITH extra AS (
    DELETE FROM public.push_subscriptions WHERE id IN (
      SELECT id FROM public.push_subscriptions WHERE user_id = v_user
       ORDER BY last_seen_at DESC OFFSET 10)
    RETURNING 1)
  SELECT count(*)::integer INTO v_over FROM extra;
  IF v_over > 0 THEN
    INSERT INTO public.push_subscription_events (user_id, event, reason, subscription_count) VALUES (v_user, 'removed', 'DEVICE_LIMIT', v_over);
  END IF;
  RETURN v_id;
END $$;

/** Baja por endpoint (al cerrar sesión o desactivar en el teléfono). Solo las propias. */
CREATE OR REPLACE FUNCTION public.app_push_unregister(p_endpoint text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid; v_n integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'PUSH_NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  WITH gone AS (DELETE FROM public.push_subscriptions WHERE user_id = v_user AND endpoint = p_endpoint RETURNING 1)
  SELECT count(*)::integer INTO v_n FROM gone;
  IF v_n > 0 THEN INSERT INTO public.push_subscription_events (user_id, event, reason, subscription_count) VALUES (v_user, 'removed', 'USER_DISABLED', v_n); END IF;
  RETURN v_n;
END $$;

/** Aviso de prueba pedido por la propia persona (como máximo uno por minuto). */
CREATE OR REPLACE FUNCTION public.app_push_test()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid; v_id uuid;
BEGIN
  IF v_user IS NULL OR public.app_is_superadmin() THEN RAISE EXCEPTION 'PUSH_NOT_ALLOWED' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = v_user) THEN RAISE EXCEPTION 'PUSH_NO_SUBSCRIPTION' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE user_id = v_user AND notification_type = 'PUSH_TEST' AND created_at > now() - interval '1 minute') THEN
    RAISE EXCEPTION 'PUSH_TEST_RATE_LIMITED' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
  VALUES (v_user, NULL, 'PUSH_TEST', NULL, NULL, 'in_app', 'sent', now())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ------------------------------------------------------------ encolar al crear el aviso

CREATE OR REPLACE FUNCTION public.app_push_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Solo tipos del catálogo y solo si la persona tiene algún teléfono activado.
  IF EXISTS (SELECT 1 FROM public.push_notification_catalog c WHERE c.notification_type = NEW.notification_type)
     AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = NEW.user_id) THEN
    INSERT INTO public.push_outbox (notification_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS notifications_push_enqueue ON notifications;
CREATE TRIGGER notifications_push_enqueue AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION public.app_push_enqueue();

-- ------------------------------------------------------------ limpieza inmediata

/** Sesión cerrada o revocada (cierre de sesión, cambio de contraseña): fuera sus suscripciones. */
CREATE OR REPLACE FUNCTION public.app_push_on_session_revoked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_n integer;
BEGIN
  WITH gone AS (DELETE FROM public.push_subscriptions WHERE session_id = NEW.id RETURNING 1)
  SELECT count(*)::integer INTO v_n FROM gone;
  IF v_n > 0 THEN
    INSERT INTO public.push_subscription_events (user_id, event, reason, subscription_count) VALUES (NEW.user_id, 'removed', 'SESSION_ENDED', v_n);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS sessions_push_cleanup ON sessions;
CREATE TRIGGER sessions_push_cleanup AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL)
  EXECUTE FUNCTION public.app_push_on_session_revoked();

/**
 * Agencia suspendida o archivada (decisión 4): se revocan las suscripciones de quienes
 * ya no tienen ningún otro acceso activo; quien conserva acceso en otra agencia mantiene su
 * teléfono, pero nada de la agencia suspendida se le envía (app_push_resolve). Se
 * descartan las entregas pendientes de esa agencia. Auditoría: un evento con los conteos.
 */
CREATE OR REPLACE FUNCTION public.app_push_revoke_for_organization(p_org uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_removed integer; v_kept integer; v_dropped integer;
BEGIN
  WITH affected AS (
    SELECT DISTINCT om.user_id FROM public.organization_memberships om WHERE om.organization_id = p_org
  ), gone AS (
    DELETE FROM public.push_subscriptions s
     WHERE s.user_id IN (SELECT user_id FROM affected)
       AND NOT public.app_push_user_has_access(s.user_id)
    RETURNING 1)
  SELECT count(*)::integer INTO v_removed FROM gone;

  SELECT count(*)::integer INTO v_kept FROM public.push_subscriptions s
   WHERE s.user_id IN (SELECT om.user_id FROM public.organization_memberships om WHERE om.organization_id = p_org);

  WITH dropped AS (
    UPDATE public.push_deliveries d SET state = 'skipped', reason = 'ORGANIZATION_INACTIVE', updated_at = now()
      FROM public.notifications n
     WHERE n.id = d.notification_id AND n.organization_id = p_org AND d.state IN ('pending', 'sending')
    RETURNING 1)
  SELECT count(*)::integer INTO v_dropped FROM dropped;
  UPDATE public.push_outbox ob SET state = 'skipped', reason = 'ORGANIZATION_INACTIVE', processed_at = now()
    FROM public.notifications n WHERE n.id = ob.notification_id AND n.organization_id = p_org AND ob.state = 'pending';

  INSERT INTO public.push_subscription_events (organization_id, event, reason, subscription_count)
  VALUES (p_org, 'removed', p_reason, v_removed);
  IF v_kept > 0 THEN
    INSERT INTO public.push_subscription_events (organization_id, event, reason, subscription_count)
    VALUES (p_org, 'removed', 'UNLINKED_OTHER_ACCESS_KEPT', v_kept);
  END IF;
  RETURN v_removed;
END $$;

CREATE OR REPLACE FUNCTION public.app_push_on_organization_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    PERFORM public.app_push_revoke_for_organization(NEW.id, 'ORGANIZATION_ARCHIVED');
  ELSIF NEW.status = 'suspended' AND OLD.status IS DISTINCT FROM 'suspended' THEN
    PERFORM public.app_push_revoke_for_organization(NEW.id, 'ORGANIZATION_SUSPENDED');
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS organizations_push_cleanup ON organizations;
CREATE TRIGGER organizations_push_cleanup AFTER UPDATE OF status, archived_at ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.app_push_on_organization_lifecycle();

-- ------------------------------------------------------------ proceso de envío (sin contexto de petición)

/** Convierte cada aviso pendiente en una entrega por teléfono vigente. Devuelve cuántas creó. */
CREATE OR REPLACE FUNCTION public.app_push_expand(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE r record; v_reason text; v_n integer; v_total integer := 0;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  FOR r IN SELECT ob.notification_id, ob.created_at, n.user_id FROM public.push_outbox ob
             JOIN public.notifications n ON n.id = ob.notification_id
            WHERE ob.state = 'pending' ORDER BY ob.created_at LIMIT greatest(1, least(p_limit, 1000))
            FOR UPDATE OF ob SKIP LOCKED
  LOOP
    IF r.created_at < now() - interval '24 hours' THEN
      UPDATE public.push_outbox SET state = 'skipped', reason = 'EXPIRED', processed_at = now() WHERE notification_id = r.notification_id;
      CONTINUE;
    END IF;
    SELECT x.reason INTO v_reason FROM public.app_push_resolve(r.notification_id) x;
    IF v_reason IS NOT NULL THEN
      UPDATE public.push_outbox SET state = 'skipped', reason = v_reason, processed_at = now() WHERE notification_id = r.notification_id;
      CONTINUE;
    END IF;
    WITH ins AS (
      INSERT INTO public.push_deliveries (notification_id, subscription_id)
      SELECT r.notification_id, s.id FROM public.push_subscriptions s WHERE s.user_id = r.user_id
      ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*)::integer INTO v_n FROM ins;
    UPDATE public.push_outbox SET state = CASE WHEN v_n > 0 THEN 'expanded' ELSE 'skipped' END,
           reason = CASE WHEN v_n > 0 THEN NULL ELSE 'NO_ACTIVE_DEVICE' END, processed_at = now()
     WHERE notification_id = r.notification_id;
    v_total := v_total + v_n;
  END LOOP;
  RETURN v_total;
END $$;

/**
 * Toma entregas listas, vuelve a comprobar el acceso y devuelve lo necesario para cifrar y
 * enviar: endpoint, claves y el texto fijo del catálogo. Nada más del aviso sale de aquí.
 */
CREATE OR REPLACE FUNCTION public.app_push_claim(p_limit integer DEFAULT 50)
RETURNS TABLE (delivery_id uuid, notification_id uuid, endpoint text, p256dh text, auth text,
               title text, body text, ttl_seconds integer, urgency text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE d record; v_reason text; v_aud text;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  -- Entregas que quedaron «enviando» por un reinicio vuelven a la cola.
  UPDATE public.push_deliveries SET state = 'pending', locked_until = NULL, updated_at = now()
   WHERE state = 'sending' AND locked_until < now();
  FOR d IN SELECT pd.id, pd.notification_id, pd.created_at, pd.subscription_id FROM public.push_deliveries pd
            WHERE pd.state = 'pending' AND pd.next_attempt_at <= now()
            ORDER BY pd.next_attempt_at LIMIT greatest(1, least(p_limit, 500))
            FOR UPDATE OF pd SKIP LOCKED
  LOOP
    IF d.created_at < now() - interval '24 hours' THEN
      UPDATE public.push_deliveries SET state = 'expired', updated_at = now() WHERE id = d.id; CONTINUE;
    END IF;
    SELECT x.reason, x.audience INTO v_reason, v_aud FROM public.app_push_resolve(d.notification_id) x;
    IF v_reason IS NOT NULL THEN
      UPDATE public.push_deliveries SET state = 'skipped', reason = v_reason, updated_at = now() WHERE id = d.id; CONTINUE;
    END IF;
    UPDATE public.push_deliveries SET state = 'sending', attempts = attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
     WHERE id = d.id;
    RETURN QUERY
      SELECT d.id, d.notification_id, s.endpoint, s.p256dh, s.auth, c.title, c.body, c.ttl_seconds, c.urgency
        FROM public.push_subscriptions s
        JOIN public.notifications n ON n.id = d.notification_id
        JOIN public.push_notification_catalog c ON c.notification_type = n.notification_type AND c.audience = v_aud
       WHERE s.id = d.subscription_id;
  END LOOP;
END $$;

/**
 * Resultado del servicio push: 2xx enviado; 404/410 el teléfono ya no existe (se borra);
 * 429/5xx/sin respuesta se reintenta con espera creciente (5 intentos); otro 4xx falla.
 */
CREATE OR REPLACE FUNCTION public.app_push_report(p_delivery uuid, p_status integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE d record;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  SELECT pd.id, pd.subscription_id, pd.attempts, s.user_id INTO d FROM public.push_deliveries pd
    JOIN public.push_subscriptions s ON s.id = pd.subscription_id
   WHERE pd.id = p_delivery AND pd.state = 'sending' FOR UPDATE OF pd;
  IF d.id IS NULL THEN RETURN 'UNKNOWN'; END IF;
  IF p_status BETWEEN 200 AND 299 THEN
    UPDATE public.push_deliveries SET state = 'sent', last_status = p_status, locked_until = NULL, updated_at = now() WHERE id = d.id;
    UPDATE public.push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = d.subscription_id;
    RETURN 'SENT';
  ELSIF p_status IN (404, 410) THEN
    DELETE FROM public.push_subscriptions WHERE id = d.subscription_id;
    INSERT INTO public.push_subscription_events (user_id, event, reason) VALUES (d.user_id, 'removed', 'ENDPOINT_GONE');
    RETURN 'GONE';
  ELSIF (p_status = 0 OR p_status = 429 OR p_status >= 500) AND d.attempts < 5 THEN
    UPDATE public.push_deliveries SET state = 'pending', last_status = p_status, locked_until = NULL,
           next_attempt_at = now() + make_interval(secs => 30 * power(2, d.attempts)::integer), updated_at = now()
     WHERE id = d.id;
    RETURN 'RETRY';
  ELSE
    UPDATE public.push_deliveries SET state = 'failed', last_status = p_status, locked_until = NULL, updated_at = now() WHERE id = d.id;
    UPDATE public.push_subscriptions SET failure_count = failure_count + 1 WHERE id = d.subscription_id;
    WITH gone AS (DELETE FROM public.push_subscriptions WHERE id = d.subscription_id AND failure_count >= 10 RETURNING 1)
    INSERT INTO public.push_subscription_events (user_id, event, reason) SELECT d.user_id, 'removed', 'REPEATED_FAILURES' FROM gone;
    RETURN 'FAILED';
  END IF;
END $$;

/**
 * Limpieza periódica: sesiones revocadas, personas sin ningún acceso activo (cuidadora dada
 * de baja, familiar sin relación), teléfonos donde no se abre ETNARA desde hace 30 días, y el historial de
 * cola/entregas de más de 7 días (solo estados y conteos). Devuelve los conteos.
 */
CREATE OR REPLACE FUNCTION public.app_push_cleanup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_session integer; v_access integer; v_stale integer; v_history integer;
BEGIN
  PERFORM public.app_assert_background_job();
  IF public.app_is_superadmin() THEN RAISE EXCEPTION 'BACKGROUND_JOB_ONLY' USING ERRCODE = '42501'; END IF;
  WITH gone AS (DELETE FROM public.push_subscriptions s USING public.sessions se
                 WHERE se.id = s.session_id AND se.revoked_at IS NOT NULL RETURNING s.user_id)
  SELECT count(*)::integer INTO v_session FROM gone;
  WITH gone AS (DELETE FROM public.push_subscriptions s WHERE NOT public.app_push_user_has_access(s.user_id) RETURNING s.user_id)
  SELECT count(*)::integer INTO v_access FROM gone;
  WITH gone AS (DELETE FROM public.push_subscriptions s
                 WHERE s.last_seen_at < now() - interval '30 days' RETURNING 1)
  SELECT count(*)::integer INTO v_stale FROM gone;
  IF v_session > 0 THEN INSERT INTO public.push_subscription_events (event, reason, subscription_count) VALUES ('removed', 'SESSION_ENDED', v_session); END IF;
  IF v_access > 0 THEN INSERT INTO public.push_subscription_events (event, reason, subscription_count) VALUES ('removed', 'NO_ACTIVE_ACCESS', v_access); END IF;
  IF v_stale > 0 THEN INSERT INTO public.push_subscription_events (event, reason, subscription_count) VALUES ('removed', 'INACTIVE_30_DAYS', v_stale); END IF;
  WITH old AS (DELETE FROM public.push_deliveries WHERE created_at < now() - interval '7 days' AND state NOT IN ('pending', 'sending') RETURNING 1)
  SELECT count(*)::integer INTO v_history FROM old;
  DELETE FROM public.push_outbox WHERE created_at < now() - interval '7 days' AND state <> 'pending';
  RETURN jsonb_build_object('session', v_session, 'noAccess', v_access, 'stale', v_stale, 'history', v_history);
END $$;

-- ------------------------------------------------------------ permisos de ejecución
REVOKE ALL ON FUNCTION public.app_push_user_has_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_resolve(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_register(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_unregister(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_test() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_enqueue() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_on_session_revoked() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_revoke_for_organization(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_on_organization_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_expand(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_claim(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_report(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_push_cleanup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_push_register(uuid, text, text, text, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_unregister(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_test() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_resolve(uuid, boolean) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_expand(integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_claim(integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_report(uuid, integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.app_push_cleanup() TO app_runtime;

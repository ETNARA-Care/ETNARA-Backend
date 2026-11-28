-- 183 · C-5: suscripciones del ECOSISTEMA ETNARA con Stripe (una sola cuenta), primero en MODO DE PRUEBA.
-- Rama integracion-connect (aprobada por Rafa el 28 nov 2026). Apagado salvo SAAS_STRIPE=on. Preparado con IA: requiere
-- revisión humana. NO confundir con la facturación de las agencias a sus clientes (billing_*, 119–127): esto es lo que
-- ETNARA cobra a las organizaciones.
--   * Planes: Care (Esencial, Profesional, Avanzado) y Premium (Care + Connect). Connect solo se vende en Connect (050).
--   * Precios CONFIGURABLES, nunca en el código: solo el DUEÑO del esquema fija el identificador de precio de Stripe
--     (y un monto informativo), con persona responsable y un historial que solo se amplía. Nunca un precio real.
--   * UN SOLO COBRO: una organización tiene como máximo UNA suscripción viva de Care o Premium (índice único). Cambiar
--     de plan = cambiar el precio de ESA suscripción en Stripe (mismo identificador): nunca dos cobros a la vez.
--   * Stripe es la fuente de verdad del cobro: la API verifica la firma del webhook y entrega aquí solo lo necesario
--     (evento, cliente, suscripción, precio, estado, fin del periodo, cancelación al vencer). Nunca datos de tarjeta.
--   * Cada evento se aplica UNA vez. MODO REAL BLOQUEADO: se rechaza todo evento o cliente «real».
--   * Derechos sincronizados: si cambia Premium de una organización vinculada a Connect, se avisa a Connect al instante
--     por la bandeja firmada de la 181 (los hechos firmados incluyen ahora premium y su vigencia).
--   * SIN COBROS SUPERPUESTOS al pasar de Connect a Premium: Connect avisa hasta cuándo está pagado su plan
--     (connect_plan_until). Premium nuevo empieza a cobrarse cuando termina lo pagado en Connect (periodo de prueba de
--     Stripe hasta esa fecha); si ya hay un plan de Care, el cambio a Premium se PROGRAMA para esa fecha. Connect, al saber
--     de Premium, cancela su plan al final del periodo: nunca se paga dos veces el mismo tiempo de Connect.

CREATE TABLE IF NOT EXISTS saas_prices (
  plan_code         text PRIMARY KEY CHECK (plan_code IN ('care_esencial', 'care_profesional', 'care_avanzado', 'premium')),
  includes_connect  boolean NOT NULL,
  stripe_price_test text UNIQUE CHECK (stripe_price_test IS NULL OR stripe_price_test ~ '^price_[A-Za-z0-9]{6,64}$'),
  stripe_price_live text UNIQUE CHECK (stripe_price_live IS NULL OR stripe_price_live ~ '^price_[A-Za-z0-9]{6,64}$'),
  amount_cents      integer CHECK (amount_cents IS NULL OR amount_cents BETWEEN 0 AND 10000000),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (includes_connect = (plan_code = 'premium'))
);
INSERT INTO saas_prices (plan_code, includes_connect) VALUES
  ('care_esencial', false), ('care_profesional', false), ('care_avanzado', false), ('premium', true)
ON CONFLICT (plan_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_price_history (
  id                bigserial PRIMARY KEY,
  plan_code         text NOT NULL REFERENCES saas_prices(plan_code),
  stripe_price_test text,
  amount_cents      integer,
  responsible       text NOT NULL CHECK (char_length(responsible) BETWEEN 2 AND 120),
  reason            text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 300),
  changed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_customers (
  organization_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  stripe_customer_id text NOT NULL UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,64}$'),
  mode               text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_subscriptions (
  stripe_subscription_id text PRIMARY KEY CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,64}$'),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_code              text NOT NULL REFERENCES saas_prices(plan_code),
  status                 text NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')),
  current_period_end     timestamptz NOT NULL,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  stripe_item_id         text CHECK (stripe_item_id IS NULL OR stripe_item_id ~ '^si_[A-Za-z0-9]{6,64}$'),
  mode                   text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- UN SOLO COBRO de Care o Premium por organización.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_subscriptions_live ON saas_subscriptions (organization_id)
  WHERE status IN ('active', 'trialing', 'past_due', 'incomplete');

-- Cambios a Premium PROGRAMADOS para cuando termina lo ya pagado en Connect.
CREATE TABLE IF NOT EXISTS saas_pending_changes (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_code       text NOT NULL REFERENCES saas_prices(plan_code) CHECK (plan_code = 'premium'),
  apply_at        timestamptz NOT NULL,
  requested_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  canceled_at     timestamptz,
  attempts        integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_pending_live ON saas_pending_changes (organization_id) WHERE applied_at IS NULL AND canceled_at IS NULL;

-- Hasta cuándo está pagado el plan de Connect de una organización vinculada (lo avisa Connect, servidor a servidor).
ALTER TABLE connect_links ADD COLUMN IF NOT EXISTS connect_plan_until timestamptz;

CREATE TABLE IF NOT EXISTS saas_events (
  event_id    text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9]{6,64}$'),
  event_type  text NOT NULL CHECK (char_length(event_type) <= 80),
  result      text NOT NULL CHECK (result IN ('applied', 'ignored', 'unknown_customer', 'unknown_price', 'second_subscription')),
  received_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saas_prices', 'saas_price_history', 'saas_customers', 'saas_subscriptions', 'saas_events', 'saas_pending_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_definer', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (current_user <> ''app_runtime'') WITH CHECK (current_user <> ''app_runtime'')', t || '_definer', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE saas_price_history_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE saas_pending_changes_id_seq FROM PUBLIC;

-- Precios: solo el dueño del esquema (operación de despliegue con persona responsable); nunca la aplicación.
CREATE OR REPLACE FUNCTION public.app_saas_price_set(p_plan text, p_price_test text, p_amount_cents integer, p_responsible text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'app_runtime' THEN RAISE EXCEPTION 'SAAS_PRICE_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  UPDATE public.saas_prices SET stripe_price_test = p_price_test, amount_cents = p_amount_cents, updated_at = now() WHERE plan_code = p_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_PLAN_UNKNOWN' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.saas_price_history (plan_code, stripe_price_test, amount_cents, responsible, reason)
  VALUES (p_plan, p_price_test, p_amount_cents, p_responsible, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_price_set(text, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_saas_price_set(text, text, integer, text, text) FROM app_runtime;

-- Derechos vigentes de una organización (lo usan Care, el estado firmado para Connect y la pantalla).
CREATE OR REPLACE FUNCTION public.app_saas_entitlement(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((SELECT jsonb_build_object('plan', s.plan_code, 'premium', s.plan_code = 'premium', 'status', s.status,
                                             'activeUntil', s.current_period_end, 'cancelAtPeriodEnd', s.cancel_at_period_end)
                     FROM public.saas_subscriptions s
                    WHERE s.organization_id = p_org AND s.status IN ('active', 'trialing', 'past_due') AND s.current_period_end > now()
                    ORDER BY s.updated_at DESC LIMIT 1),
                  jsonb_build_object('plan', NULL, 'premium', false, 'status', NULL, 'activeUntil', NULL, 'cancelAtPeriodEnd', false));
$$;
REVOKE ALL ON FUNCTION public.app_saas_entitlement(uuid) FROM PUBLIC;

-- Pantalla de la organización (cualquier miembro activo ve su plan; nunca montos de otras ni datos de tarjeta).
CREATE OR REPLACE FUNCTION public.app_saas_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organization_memberships m WHERE m.organization_id = v_org AND m.user_id = v_user AND m.status = 'active') THEN
    RAISE EXCEPTION 'SAAS_MEMBERSHIP_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('entitlement', public.app_saas_entitlement(v_org),
    'pendingPremiumAt', (SELECT p.apply_at FROM public.saas_pending_changes p WHERE p.organization_id = v_org AND p.applied_at IS NULL AND p.canceled_at IS NULL),
    'connectPlanUntil', (SELECT l.connect_plan_until FROM public.connect_links l WHERE l.organization_id = v_org AND l.revoked_at IS NULL),
    'plans', (SELECT jsonb_agg(jsonb_build_object('code', p.plan_code, 'includesConnect', p.includes_connect,
                                                  'available', p.stripe_price_test IS NOT NULL, 'amountCents', p.amount_cents) ORDER BY p.plan_code)
                FROM public.saas_prices p));
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_status() TO app_runtime;

-- Datos para la sesión de pago (administración). Con una suscripción viva no se abre otra: se cambia de plan en ella.
CREATE OR REPLACE FUNCTION public.app_saas_checkout_data(p_plan text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
        v_price text; v_customer text; v_email text; v_connect timestamptz; v_trial timestamptz;
BEGIN
  IF NOT public.app_is_org_admin() THEN RAISE EXCEPTION 'SAAS_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT stripe_price_test INTO v_price FROM public.saas_prices WHERE plan_code = p_plan;
  IF v_price IS NULL THEN RAISE EXCEPTION 'SAAS_PRICE_NOT_CONFIGURED' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.saas_subscriptions s WHERE s.organization_id = v_org AND s.status IN ('active', 'trialing', 'past_due', 'incomplete')) THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_ACTIVE' USING ERRCODE = '55000';
  END IF;
  -- Premium con un plan de Connect ya pagado: Premium se cobra desde que termina lo pagado (sin superposición).
  IF p_plan = 'premium' THEN
    SELECT l.connect_plan_until INTO v_connect FROM public.connect_links l WHERE l.organization_id = v_org AND l.revoked_at IS NULL;
    IF v_connect > now() THEN
      IF v_connect < now() + interval '48 hours' THEN RAISE EXCEPTION 'SAAS_PREMIUM_AFTER_CONNECT' USING ERRCODE = '55000'; END IF;
      v_trial := v_connect;
    END IF;
  END IF;
  SELECT stripe_customer_id INTO v_customer FROM public.saas_customers WHERE organization_id = v_org;
  SELECT lower(email) INTO v_email FROM public.users WHERE id = v_user;
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (v_user, v_org, 'SAAS_CHECKOUT_REQUESTED', 'organization', v_org);
  RETURN jsonb_build_object('organizationId', v_org, 'priceId', v_price, 'customerId', v_customer, 'email', v_email, 'plan', p_plan,
                            'trialEnd', CASE WHEN v_trial IS NOT NULL THEN extract(epoch FROM v_trial)::bigint END);
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_checkout_data(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_checkout_data(text) TO app_runtime;

-- Evento verificado de Stripe (servidor, sin persona). Idempotente. Devuelve el resultado.
CREATE OR REPLACE FUNCTION public.app_saas_stripe_event(p_event text, p_type text, p_mode text, p_org uuid, p_customer text,
                                                        p_subscription text, p_price text, p_status text, p_period_end timestamptz,
                                                        p_cancel_at_end boolean, p_item text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := p_org; v_plan text; v_res text := 'applied'; v_before boolean; v_after boolean;
BEGIN
  IF p_mode IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'SAAS_LIVE_MODE_BLOCKED' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.saas_events WHERE event_id = p_event) THEN RETURN 'duplicate'; END IF;
  IF v_org IS NULL AND p_customer IS NOT NULL THEN SELECT organization_id INTO v_org FROM public.saas_customers WHERE stripe_customer_id = p_customer; END IF;
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org) THEN v_res := 'unknown_customer';
  ELSIF p_type = 'checkout.session.completed' THEN
    IF p_customer IS NOT NULL THEN
      INSERT INTO public.saas_customers (organization_id, stripe_customer_id) VALUES (v_org, p_customer)
      ON CONFLICT (organization_id) DO NOTHING;
    END IF;
  ELSIF p_type IN ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted') THEN
    SELECT plan_code INTO v_plan FROM public.saas_prices WHERE stripe_price_test = p_price;
    IF v_plan IS NULL THEN v_res := 'unknown_price';
    ELSE
      v_before := (public.app_saas_entitlement(v_org)->>'premium')::boolean;
      BEGIN
        INSERT INTO public.saas_subscriptions (stripe_subscription_id, organization_id, plan_code, status, current_period_end, cancel_at_period_end, stripe_item_id)
        VALUES (p_subscription, v_org, v_plan, CASE WHEN p_type = 'customer.subscription.deleted' THEN 'canceled' ELSE p_status END,
                p_period_end, coalesce(p_cancel_at_end, false), p_item)
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status,
          current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
          stripe_item_id = coalesce(EXCLUDED.stripe_item_id, saas_subscriptions.stripe_item_id), updated_at = now()
        WHERE saas_subscriptions.organization_id = v_org;
      EXCEPTION WHEN unique_violation THEN
        v_res := 'second_subscription';   -- una SEGUNDA suscripción viva: no se registra (ETNARA la revisa y la cancela)
      END;
      v_after := (public.app_saas_entitlement(v_org)->>'premium')::boolean;
      IF v_before IS DISTINCT FROM v_after AND EXISTS (SELECT 1 FROM public.connect_links l WHERE l.organization_id = v_org AND l.revoked_at IS NULL) THEN
        INSERT INTO public.connect_outbox (organization_id, event_type) VALUES (v_org, 'ORG_STATUS_CHANGED');
      END IF;
    END IF;
  ELSE v_res := 'ignored';
  END IF;
  INSERT INTO public.saas_events (event_id, event_type, result) VALUES (p_event, p_type, v_res);
  IF v_res = 'applied' AND v_org IS NOT NULL THEN
    INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
    VALUES (NULL, v_org, 'SAAS_STRIPE_EVENT', 'organization', v_org);
  END IF;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_stripe_event(text, text, text, uuid, text, text, text, text, timestamptz, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_stripe_event(text, text, text, uuid, text, text, text, text, timestamptz, boolean, text) TO app_runtime;

-- Connect (servidor a servidor) avisa hasta cuándo está pagado su plan. 'ok' | 'not_linked'.
CREATE OR REPLACE FUNCTION public.app_connect_plan_notice(p_ref uuid, p_until timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Auditoría: una fecha absurda dejaría Premium sin empezar (y Stripe rechaza un periodo de prueba de más de 2 años).
  IF p_until > now() + interval '400 days' THEN RETURN 'invalid'; END IF;
  UPDATE public.connect_links SET connect_plan_until = CASE WHEN p_until > now() THEN p_until END
   WHERE connect_provider_ref = p_ref::text AND revoked_at IS NULL;
  RETURN CASE WHEN FOUND THEN 'ok' ELSE 'not_linked' END;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_plan_notice(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_plan_notice(uuid, timestamptz) TO app_runtime;

-- Pasar a Premium con una suscripción de Care viva (administración). Si hay un plan de Connect pagado, se PROGRAMA para
-- cuando termina; si no, se aplica ya (la API cambia el precio de ESA suscripción en Stripe, con prorrateo: un solo cobro).
CREATE OR REPLACE FUNCTION public.app_saas_upgrade_premium()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_org uuid := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
        v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
        s public.saas_subscriptions%ROWTYPE; v_connect timestamptz; v_price text;
BEGIN
  IF NOT public.app_is_org_admin() THEN RAISE EXCEPTION 'SAAS_ADMIN_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM public.saas_subscriptions x WHERE x.organization_id = v_org AND x.status IN ('active', 'trialing', 'past_due') ORDER BY updated_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_NO_SUBSCRIPTION' USING ERRCODE = '55000'; END IF;
  IF s.plan_code = 'premium' THEN RAISE EXCEPTION 'SAAS_ALREADY_PREMIUM' USING ERRCODE = '55000'; END IF;
  SELECT stripe_price_test INTO v_price FROM public.saas_prices WHERE plan_code = 'premium';
  IF v_price IS NULL THEN RAISE EXCEPTION 'SAAS_PRICE_NOT_CONFIGURED' USING ERRCODE = '22023'; END IF;
  IF s.stripe_item_id IS NULL THEN RAISE EXCEPTION 'SAAS_SUBSCRIPTION_ITEM_UNKNOWN' USING ERRCODE = '55000'; END IF;
  SELECT l.connect_plan_until INTO v_connect FROM public.connect_links l WHERE l.organization_id = v_org AND l.revoked_at IS NULL;
  IF v_connect > now() THEN
    INSERT INTO public.saas_pending_changes (organization_id, plan_code, apply_at, requested_by) VALUES (v_org, 'premium', v_connect, v_user)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
    VALUES (v_user, v_org, 'SAAS_PREMIUM_SCHEDULED', 'organization', v_org);
    -- Connect lo sabe al instante y no renueva su plan (termina justo cuando empieza Premium).
    INSERT INTO public.connect_outbox (organization_id, event_type) VALUES (v_org, 'ORG_STATUS_CHANGED');
    RETURN jsonb_build_object('action', 'scheduled', 'applyAt', v_connect);
  END IF;
  INSERT INTO public.audit_log (actor_user_id, organization_id, action, entity_type, entity_id)
  VALUES (v_user, v_org, 'SAAS_PREMIUM_UPGRADE_NOW', 'organization', v_org);
  RETURN jsonb_build_object('action', 'now', 'subscriptionId', s.stripe_subscription_id, 'itemId', s.stripe_item_id, 'priceId', v_price);
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_upgrade_premium() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_upgrade_premium() TO app_runtime;

-- Repartidor (servidor): cambios programados que vencieron, con la suscripción y el precio. Reintenta con espera.
CREATE OR REPLACE FUNCTION public.app_saas_pending_due(p_limit integer)
RETURNS TABLE (id bigint, organization_id uuid, subscription_id text, item_id text, price_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    WITH c AS (SELECT p.id FROM public.saas_pending_changes p
                WHERE p.applied_at IS NULL AND p.canceled_at IS NULL AND p.apply_at <= now() AND p.attempts < 20
                ORDER BY p.apply_at LIMIT least(greatest(p_limit, 1), 50) FOR UPDATE SKIP LOCKED),
    u AS (UPDATE public.saas_pending_changes p SET attempts = p.attempts + 1 FROM c WHERE p.id = c.id
          RETURNING p.id, p.organization_id, p.plan_code)
    SELECT u.id, u.organization_id, s.stripe_subscription_id, s.stripe_item_id, pr.stripe_price_test
      FROM u
      JOIN public.saas_prices pr ON pr.plan_code = u.plan_code
      LEFT JOIN LATERAL (SELECT x.stripe_subscription_id, x.stripe_item_id FROM public.saas_subscriptions x
                          WHERE x.organization_id = u.organization_id AND x.status IN ('active', 'trialing', 'past_due')
                          ORDER BY x.updated_at DESC LIMIT 1) s ON true;
END;
$$;
REVOKE ALL ON FUNCTION public.app_saas_pending_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_pending_due(integer) TO app_runtime;

CREATE OR REPLACE FUNCTION public.app_saas_pending_done(p_id bigint, p_ok boolean, p_cancel boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.saas_pending_changes SET applied_at = CASE WHEN p_ok THEN now() END, canceled_at = CASE WHEN p_cancel THEN now() END
   WHERE id = p_id AND applied_at IS NULL AND canceled_at IS NULL AND (p_ok OR p_cancel)
$$;
REVOKE ALL ON FUNCTION public.app_saas_pending_done(bigint, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_saas_pending_done(bigint, boolean, boolean) TO app_runtime;

-- Los hechos firmados para Connect incluyen ahora Premium (un solo cobro: Connect no cobra aparte).
CREATE OR REPLACE FUNCTION public.app_connect_org_facts(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'organizationId', o.id,
    'type', CASE o.organization_type::text WHEN 'INDEPENDENT_PROVIDER' THEN 'independiente'
                                           WHEN 'RESIDENTIAL_CARE_HOME' THEN 'hogar' ELSE 'agencia' END,
    'active', o.status::text IN ('trial', 'active') AND o.archived_at IS NULL,
    'suspended', o.status::text = 'suspended' OR o.archived_at IS NOT NULL,
    'contractSatisfied', coalesce((SELECT s.satisfied FROM public.app_contract_enforcement_state(o.id) s), false),
    'subscriptionOrder', EXISTS (
      SELECT 1 FROM public.organization_contract_acceptances a
        JOIN public.contract_document_versions v ON v.id = a.document_version_id
        JOIN public.contract_documents d ON d.id = v.document_id
       WHERE a.organization_id = o.id AND d.kind = 'SUBSCRIPTION_ORDER' AND v.status = 'published' AND NOT a.is_test),
    'connectProviderRef', (SELECT l.connect_provider_ref FROM public.connect_links l WHERE l.organization_id = o.id AND l.revoked_at IS NULL),
    'premium', (public.app_saas_entitlement(o.id)->>'premium')::boolean,
    'premiumUntil', CASE WHEN (public.app_saas_entitlement(o.id)->>'premium')::boolean THEN public.app_saas_entitlement(o.id)->'activeUntil' END,
    'premiumScheduled', EXISTS (SELECT 1 FROM public.saas_pending_changes p WHERE p.organization_id = o.id AND p.applied_at IS NULL AND p.canceled_at IS NULL))
  FROM public.organizations o WHERE o.id = p_org
$$;
REVOKE ALL ON FUNCTION public.app_connect_org_facts(uuid) FROM PUBLIC;

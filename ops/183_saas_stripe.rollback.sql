-- Reversión de 183_saas_stripe (C-5). Borra precios, clientes, suscripciones y eventos de Stripe (modo de prueba) del
-- ecosistema y devuelve los hechos firmados para Connect a los de la 181 (sin Premium). No toca la facturación de las
-- agencias a sus clientes (billing_*).
BEGIN;
DROP FUNCTION IF EXISTS public.app_saas_pending_done(bigint, boolean, boolean);
DROP FUNCTION IF EXISTS public.app_saas_pending_due(integer);
DROP FUNCTION IF EXISTS public.app_saas_upgrade_premium();
DROP FUNCTION IF EXISTS public.app_connect_plan_notice(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.app_saas_stripe_event(text, text, text, uuid, text, text, text, text, timestamptz, boolean, text);
DROP FUNCTION IF EXISTS public.app_saas_checkout_data(text);
DROP FUNCTION IF EXISTS public.app_saas_status();
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
    'connectProviderRef', (SELECT l.connect_provider_ref FROM public.connect_links l WHERE l.organization_id = o.id AND l.revoked_at IS NULL))
  FROM public.organizations o WHERE o.id = p_org
$$;
REVOKE ALL ON FUNCTION public.app_connect_org_facts(uuid) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.app_saas_entitlement(uuid);
DROP FUNCTION IF EXISTS public.app_saas_price_set(text, text, integer, text, text);
DROP TABLE IF EXISTS public.saas_events;
DROP TABLE IF EXISTS public.saas_pending_changes;
ALTER TABLE public.connect_links DROP COLUMN IF EXISTS connect_plan_until;
DROP TABLE IF EXISTS public.saas_subscriptions;
DROP TABLE IF EXISTS public.saas_customers;
DROP TABLE IF EXISTS public.saas_price_history;
DROP TABLE IF EXISTS public.saas_prices;
DELETE FROM public.schema_migrations WHERE filename = '183_saas_stripe.sql';
COMMIT;

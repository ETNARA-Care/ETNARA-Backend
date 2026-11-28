-- Reversión de 182_connect_transfers (C-4). Borra las transferencias recibidas de Connect y los enlaces familia ↔
-- persona atendida (las personas atendidas creadas NO se borran). Restaura la bandeja de la 181.
BEGIN;
DROP FUNCTION IF EXISTS public.app_connect_transfer_decide(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.app_connect_transfers_list();
DROP FUNCTION IF EXISTS public.app_connect_transfer_withdraw(uuid, uuid);
DROP FUNCTION IF EXISTS public.app_connect_transfer_receive(uuid, uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.app_connect_transfer_payload_ok(jsonb);
DROP TABLE IF EXISTS public.connect_recipient_links;
DROP TABLE IF EXISTS public.connect_transfers;
DELETE FROM public.connect_outbox WHERE event_type = 'TRANSFER_DECIDED';
ALTER TABLE public.connect_outbox DROP CONSTRAINT IF EXISTS connect_outbox_event_type_check;
ALTER TABLE public.connect_outbox ADD CONSTRAINT connect_outbox_event_type_check CHECK (event_type IN ('ORG_STATUS_CHANGED', 'LINK_REVOKED'));
ALTER TABLE public.connect_outbox DROP COLUMN IF EXISTS payload;
DROP FUNCTION IF EXISTS public.app_connect_outbox_claim(integer);
CREATE FUNCTION public.app_connect_outbox_claim(p_limit integer)
RETURNS TABLE (id bigint, event_type text, facts jsonb, connect_provider_ref text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    WITH c AS (
      SELECT x.id FROM public.connect_outbox x
       WHERE x.delivered_at IS NULL AND x.next_attempt_at <= now() AND x.created_at > now() - interval '7 days'
       ORDER BY x.id LIMIT least(greatest(p_limit, 1), 100) FOR UPDATE SKIP LOCKED),
    u AS (
      UPDATE public.connect_outbox x SET attempts = x.attempts + 1, next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, x.attempts)::int))
        FROM c WHERE x.id = c.id RETURNING x.id, x.event_type, x.organization_id)
    SELECT u.id, u.event_type, public.app_connect_org_facts(u.organization_id),
           (SELECT l.connect_provider_ref FROM public.connect_links l WHERE l.organization_id = u.organization_id ORDER BY l.revoked_at NULLS FIRST LIMIT 1)
      FROM u;
END;
$$;
REVOKE ALL ON FUNCTION public.app_connect_outbox_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_connect_outbox_claim(integer) TO app_runtime;
DELETE FROM public.schema_migrations WHERE filename = '182_connect_transfers.sql';
COMMIT;

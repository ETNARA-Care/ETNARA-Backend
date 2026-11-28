import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 183 · C-5: Stripe del ecosistema ETNARA (una sola cuenta), SOLO MODO DE PRUEBA. Apagado salvo SAAS_STRIPE=on con:
 *   STRIPE_SECRET_KEY      sk_test_… / rk_test_… (una clave REAL detiene el arranque de este módulo)
 *   STRIPE_WEBHOOK_SECRET  whsec_… del punto de entrega de Care
 *   SAAS_RETURN_URL        https://… a donde vuelve la persona tras pagar
 * Nunca se registran las claves ni los cuerpos.
 */
export interface SaasConfig { secretKey: string; webhookSecret: string; returnUrl: string }
export class SaasConfigError extends Error {}

export function saasConfig(env: NodeJS.ProcessEnv = process.env): SaasConfig | null {
  if (env.SAAS_STRIPE !== "on") return null;
  const secretKey = env.STRIPE_SECRET_KEY ?? "", webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? "", returnUrl = (env.SAAS_RETURN_URL ?? "").replace(/\/+$/, "");
  if (/^(sk|rk)_live_/.test(secretKey)) throw new SaasConfigError("STRIPE_SECRET_KEY es REAL: los cobros reales no están autorizados");
  if (!/^(sk|rk)_test_[A-Za-z0-9]{16,}$/.test(secretKey) || !/^whsec_[A-Za-z0-9+/=]{16,}$/.test(webhookSecret)) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9/_-]*)?$/.test(returnUrl)) return null;
  return { secretKey, webhookSecret, returnUrl };
}

/** Firma de Stripe: t=…,v1=HMAC_SHA256(secreto, `${t}.${cuerpo}`) sobre el cuerpo EXACTO, ±5 minutos. */
export function stripeSignatureValid(secret: string, header: string | undefined, body: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return parts.filter(([k]) => k === "v1").some(([, v]) => {
    const b = Buffer.from(v ?? "", "hex");
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

export interface SaasEvent { id: string; type: string; mode: "test" | "live"; organizationId: string | null; customer: string | null;
  subscription: string | null; price: string | null; status: string | null; periodEnd: Date | null; cancelAtPeriodEnd: boolean | null; item: string | null }
const s = (v: unknown) => (typeof v === "string" ? v : null);
export function parseStripeEvent(body: string): SaasEvent | null {
  let e: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { e = JSON.parse(body); } catch { return null; }
  if (typeof e?.id !== "string" || typeof e.type !== "string") return null;
  const o = e.data?.object ?? {};
  const meta = o.metadata ?? {};
  const org = s(meta.organization_id) ?? s(o.client_reference_id);
  return {
    id: e.id, type: e.type, mode: e.livemode ? "live" : "test",
    organizationId: org && /^[0-9a-f-]{36}$/.test(org) ? org : null,
    customer: s(o.customer), subscription: e.type.startsWith("customer.subscription.") ? s(o.id) : s(o.subscription),
    price: s(o.items?.data?.[0]?.price?.id),
    status: s(o.status),
    periodEnd: typeof (o.current_period_end ?? o.items?.data?.[0]?.current_period_end) === "number" ? new Date((o.current_period_end ?? o.items.data[0].current_period_end) * 1000) : null,
    cancelAtPeriodEnd: typeof o.cancel_at_period_end === "boolean" ? o.cancel_at_period_end : null,
    item: e.type.startsWith("customer.subscription.") ? s(o.items?.data?.[0]?.id) : null,
  };
}

/** Sesión de pago (modo suscripción). La tarjeta la escribe la persona SOLO en Stripe. */
export async function createCheckoutSession(cfg: SaasConfig, d: { organizationId: string; priceId: string; customerId: string | null; email: string | null; plan: string; trialEnd?: number | null },
  pedir: typeof fetch = fetch): Promise<{ url: string }> {
  const form = new URLSearchParams({
    mode: "subscription", "line_items[0][price]": d.priceId, "line_items[0][quantity]": "1",
    client_reference_id: d.organizationId, "subscription_data[metadata][organization_id]": d.organizationId,
    "subscription_data[metadata][plan]": d.plan, "metadata[organization_id]": d.organizationId,
    success_url: `${cfg.returnUrl}?plan=ok`, cancel_url: `${cfg.returnUrl}?plan=cancelado`,
  });
  if (d.customerId) form.set("customer", d.customerId); else if (d.email) form.set("customer_email", d.email);
  // Premium con un plan de Connect ya pagado: no se cobra hasta que termina lo pagado (sin superposición).
  if (d.trialEnd) form.set("subscription_data[trial_end]", String(d.trialEnd));
  const r = await pedir("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => ({}))) as { url?: unknown; livemode?: unknown };
  if (!r.ok || typeof j.url !== "string" || !j.url.startsWith("https://checkout.stripe.com/") || j.livemode === true) throw new SaasConfigError("STRIPE_CHECKOUT_FAILED");
  return { url: j.url };
}

/** Cambia el precio de la MISMA suscripción (un solo cobro), con prorrateo de Stripe. */
export async function changeSubscriptionPrice(cfg: SaasConfig, subscriptionId: string, itemId: string, priceId: string, pedir: typeof fetch = fetch): Promise<boolean> {
  if (!/^sub_[A-Za-z0-9]{6,64}$/.test(subscriptionId) || !/^si_[A-Za-z0-9]{6,64}$/.test(itemId) || !/^price_[A-Za-z0-9]{6,64}$/.test(priceId)) return false;
  const form = new URLSearchParams({ "items[0][id]": itemId, "items[0][price]": priceId, proration_behavior: "create_prorations" });
  try {
    const r = await pedir(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: "POST", headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch { return false; }
}

import express, { Router, type Request, type Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../config/db.js";
import { withTenantContext } from "../../context/tenantContext.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { isTenantAccessDenied, TENANT_ACCESS_DENIED_BODY } from "../../security/tenantAccessDenied.js";
import { respondInternalError } from "../../observability/internalError.js";
import { kickConnectOutbox } from "../connect/connect.worker.js";
import { changeSubscriptionPrice, createCheckoutSession, parseStripeEvent, saasConfig, stripeSignatureValid } from "./saas.stripe.js";

/**
 * 183 · C-5: suscripciones del ecosistema ETNARA (Care y Premium) con Stripe en MODO DE PRUEBA. Con SAAS_STRIPE apagado
 * (o incompleto) todas responden 404.
 *   GET  /organizations/:organizationId/saas            plan vigente y planes disponibles (cualquier miembro activo)
 *   POST /organizations/:organizationId/saas/checkout   sesión de pago de Stripe (administración; sin otra suscripción viva)
 *   POST /organizations/:organizationId/saas/premium    pasar a Premium con una suscripción de Care viva (administración):
 *                                                       ya, o PROGRAMADO para cuando termina lo pagado en Connect
 *   POST /integrations/stripe/webhook                   eventos de Stripe (firma sobre el cuerpo EXACTO); idempotente
 */
export const STRIPE_WEBHOOK_PATH = "/integrations/stripe/webhook";
/** Se monta ANTES de express.json(): el webhook necesita el cuerpo exacto para verificar la firma. */
export const stripeRawBody = express.raw({ type: "application/json", limit: "256kb" });

const router = Router();
const uuid = z.string().uuid();
const Checkout = z.object({ plan: z.enum(["care_esencial", "care_profesional", "care_avanzado", "premium"]) }).strict();
const ERR: Record<string, number> = { SAAS_ADMIN_REQUIRED: 403, SAAS_MEMBERSHIP_REQUIRED: 403, SAAS_PRICE_NOT_CONFIGURED: 409, SAAS_SUBSCRIPTION_ACTIVE: 409,
  SAAS_PREMIUM_AFTER_CONNECT: 409, SAAS_NO_SUBSCRIPTION: 409, SAAS_ALREADY_PREMIUM: 409, SAAS_SUBSCRIPTION_ITEM_UNKNOWN: 409 };

router.use(["/organizations/:organizationId/saas", STRIPE_WEBHOOK_PATH], (_req, res, next) => {
  let cfg; try { cfg = saasConfig(); } catch { cfg = null; }
  if (!cfg) { res.status(404).json({ error: "NOT_FOUND" }); return; }
  next();
});
function fail(res: Response, err: unknown, req: Request) {
  const m = err instanceof Error ? err.message : "";
  const code = Object.keys(ERR).find((c) => m.includes(c));
  if (code) { res.status(ERR[code]).json({ error: code }); return; }
  if (isTenantAccessDenied(err)) { res.status(403).json(TENANT_ACCESS_DENIED_BODY); return; }
  if (m === "STRIPE_CHECKOUT_FAILED") { res.status(502).json({ error: "STRIPE_UNAVAILABLE" }); return; }
  respondInternalError(res, "saas", err, req);
}

export let saasFetch: typeof fetch = fetch;
export function setSaasFetchForTests(f: typeof fetch) { saasFetch = f; }

router.get("/organizations/:organizationId/saas", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try {
    const r = await withTenantContext({ userId: req.auth!.userId, organizationId: o.data }, async (trx) => (await sql<{ s: unknown }>`SELECT public.app_saas_status() AS s`.execute(trx)).rows[0].s);
    res.setHeader("Cache-Control", "no-store"); res.json({ saas: r, mode: "test" });
  } catch (e) { fail(res, e, req); }
});

router.post("/organizations/:organizationId/saas/checkout", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); const b = Checkout.safeParse(req.body);
  if (!o.success || !b.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const d = await withTenantContext({ userId: req.auth!.userId, organizationId: o.data }, async (trx) =>
      (await sql<{ d: { organizationId: string; priceId: string; customerId: string | null; email: string | null; plan: string; trialEnd: number | null } }>`SELECT public.app_saas_checkout_data(${b.data.plan}) AS d`.execute(trx)).rows[0].d);
    res.setHeader("Cache-Control", "no-store");
    res.json(await createCheckoutSession(saasConfig()!, d, saasFetch));
  } catch (e) { fail(res, e, req); }
});

router.post("/organizations/:organizationId/saas/premium", requireAuth, async (req: AuthenticatedRequest, res) => {
  const o = uuid.safeParse(req.params.organizationId); if (!o.success) { res.status(400).json({ error: "INVALID_ORGANIZATION_ID" }); return; }
  try {
    const r = await withTenantContext({ userId: req.auth!.userId, organizationId: o.data }, async (trx) =>
      (await sql<{ r: { action: "now" | "scheduled"; applyAt?: string; subscriptionId?: string; itemId?: string; priceId?: string } }>`SELECT public.app_saas_upgrade_premium() AS r`.execute(trx)).rows[0].r);
    if (r.action === "scheduled") { res.json({ scheduled: true, applyAt: r.applyAt }); return; }
    const ok = await changeSubscriptionPrice(saasConfig()!, r.subscriptionId!, r.itemId!, r.priceId!, saasFetch);
    if (!ok) { res.status(502).json({ error: "STRIPE_UNAVAILABLE" }); return; }
    res.json({ scheduled: false, applied: true });   // el webhook de Stripe actualizará el plan
  } catch (e) { fail(res, e, req); }
});

/** Cambios a Premium programados que vencieron (cuando terminó lo pagado en Connect). Devuelve conteos. */
export async function runSaasPendingTick(pedir: typeof fetch = saasFetch) {
  let cfg; try { cfg = saasConfig(); } catch { cfg = null; }
  const res = { applied: 0, canceled: 0, retry: 0 };
  if (!cfg) return res;
  const due = (await sql<{ id: string; organization_id: string; subscription_id: string | null; item_id: string | null; price_id: string | null }>`SELECT * FROM public.app_saas_pending_due(20)`.execute(db)).rows;
  for (const d of due) {
    if (!d.subscription_id || !d.item_id || !d.price_id) { await sql`SELECT public.app_saas_pending_done(${d.id}::bigint, false, true)`.execute(db); res.canceled++; continue; }
    const ok = await changeSubscriptionPrice(cfg, d.subscription_id, d.item_id, d.price_id, pedir);
    if (ok) { await sql`SELECT public.app_saas_pending_done(${d.id}::bigint, true, false)`.execute(db); res.applied++; } else res.retry++;
  }
  return res;
}
export function startSaasWorker(): void {
  let cfg; try { cfg = saasConfig(); } catch { cfg = null; }
  if (!cfg) return;
  setInterval(() => { void runSaasPendingTick().catch(() => undefined); }, 10 * 60_000).unref();
}

router.post(STRIPE_WEBHOOK_PATH, async (req, res) => {
  const cfg = saasConfig()!;
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const sig = typeof req.headers["stripe-signature"] === "string" ? req.headers["stripe-signature"] : undefined;
  if (!stripeSignatureValid(cfg.webhookSecret, sig, body)) { res.status(401).json({ error: "INVALID_SIGNATURE" }); return; }
  const e = parseStripeEvent(body);
  if (!e) { res.status(200).json({ ok: true }); return; }
  if (e.mode !== "test") { res.status(200).json({ ok: true, result: "live_ignored" }); return; }   // cobros reales: no autorizados
  try {
    const r = (await sql<{ r: string }>`SELECT public.app_saas_stripe_event(${e.id}, ${e.type}, ${e.mode}, ${e.organizationId}::uuid, ${e.customer},
      ${e.subscription}, ${e.price}, ${e.status}, ${e.periodEnd}, ${e.cancelAtPeriodEnd}, ${e.item}) AS r`.execute(db)).rows[0].r;
    kickConnectOutbox();   // si cambió Premium de una organización vinculada, Connect lo sabe al instante
    res.status(200).json({ ok: true, result: r });
  } catch {
    res.status(503).setHeader("Retry-After", "60").json({ error: "RETRY" });
  }
});

export default router;

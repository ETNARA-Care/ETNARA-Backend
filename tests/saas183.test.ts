import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStripeEvent, saasConfig, SaasConfigError, stripeSignatureValid } from "../src/modules/saas/saas.stripe.js";

const WH = "whsec_" + "b".repeat(32);
const env = (o: Record<string, string> = {}) => ({ SAAS_STRIPE: "on", STRIPE_SECRET_KEY: "sk_test_" + "a".repeat(24), STRIPE_WEBHOOK_SECRET: WH, SAAS_RETURN_URL: "https://app.etnaracare.com/agency/settings", ...o }) as NodeJS.ProcessEnv;
const firmar = (body: string, t = Math.floor(Date.now() / 1000), secret = WH) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("183 · Stripe del ecosistema (sin base)", () => {
  it("apagado por omisión; una clave REAL detiene el módulo; exige webhook y retorno https", () => {
    expect(saasConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(saasConfig(env())).not.toBeNull();
    expect(() => saasConfig(env({ STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24) }))).toThrow(SaasConfigError);
    expect(() => saasConfig(env({ STRIPE_SECRET_KEY: "rk_live_" + "x".repeat(24) }))).toThrow(SaasConfigError);
    expect(saasConfig(env({ STRIPE_WEBHOOK_SECRET: "x" }))).toBeNull();
    expect(saasConfig(env({ SAAS_RETURN_URL: "http://app.etnaracare.com" }))).toBeNull();
  });
  it("firma: cuerpo exacto, secreto correcto, dentro de 5 minutos", () => {
    const b = '{"id":"evt_x"}';
    expect(stripeSignatureValid(WH, firmar(b), b)).toBe(true);
    expect(stripeSignatureValid(WH, firmar(b), b + " ")).toBe(false);
    expect(stripeSignatureValid(WH, firmar(b, undefined, "whsec_" + "c".repeat(32)), b)).toBe(false);
    expect(stripeSignatureValid(WH, firmar(b, Math.floor(Date.now() / 1000) - 400), b)).toBe(false);
    expect(stripeSignatureValid(WH, undefined, b)).toBe(false);
  });
  it("interpreta solo lo necesario (sin datos de tarjeta) y distingue el modo real", () => {
    const e = parseStripeEvent(JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", livemode: true,
      data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1800000000, cancel_at_period_end: true,
        metadata: { organization_id: "11111111-1111-4111-8111-111111111111" }, items: { data: [{ price: { id: "price_1" } }] }, payment_method: "pm_x" } } }))!;
    expect(e).toMatchObject({ mode: "live", subscription: "sub_1", price: "price_1", cancelAtPeriodEnd: true, organizationId: "11111111-1111-4111-8111-111111111111" });
    expect(JSON.stringify(e)).not.toContain("pm_x");
    expect(parseStripeEvent("no json")).toBeNull();
  });
});

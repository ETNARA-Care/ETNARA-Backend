import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashCode, maskEmail, maskPhone, normalizeNanpPhone, sameHash } from "../src/modules/accountSecurity/phone.js";
import { SMS_TEXT, twilioVerifyProvider } from "../src/modules/accountSecurity/smsCore.js";

const strip = (s: string) => s.replace(/--.*$/gm, "");
const m117 = strip(readFileSync("migrations/117_account_phone_verification.sql", "utf8"));
const rollback = strip(readFileSync("ops/117_account_phone_verification.rollback.sql", "utf8"));
const provider = readFileSync("src/modules/accountSecurity/smsProvider.ts", "utf8");

describe("phone numbers (+1: Puerto Rico and US)", () => {
  it("normalises what people type to E.164", () => {
    for (const typed of ["(787) 555-0101", "787-555-0101", "787.555.0101", "+1 787 555 0101", "17875550101", "7875550101"]) {
      expect(normalizeNanpPhone(typed)).toBe("+17875550101");
    }
    expect(normalizeNanpPhone("939 555 0101")).toBe("+19395550101");
  });
  it("refuses anything that is not a valid +1 number", () => {
    for (const bad of ["+44 20 7946 0000", "555-0101", "(787) 155-0101", "(087) 555-0101", "787555010", "correo@x.com", "+1 787 555 0101 ext 2", ""]) {
      expect(normalizeNanpPhone(bad)).toBeNull();
    }
  });
  it("shows only the last 4 digits and a masked e-mail", () => {
    expect(maskPhone("+17875550101")).toBe("•••-•••-0101");
    expect(maskEmail("maria@example.com")).toBe("m•••@example.com");
  });
  it("codes are stored as an HMAC bound to purpose and number", () => {
    const a = hashCode("s".repeat(32), "VERIFY", "+17875550101", "123456");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(a, hashCode("s".repeat(32), "VERIFY", "+17875550101", "123456"))).toBe(true);
    expect(sameHash(a, hashCode("s".repeat(32), "RESET", "+17875550101", "123456"))).toBe(false);
    expect(sameHash(a, hashCode("s".repeat(32), "VERIFY", "+17875550102", "123456"))).toBe(false);
  });
  it("SMS text: no names or health data; Android autofill line for the app domain", () => {
    expect(SMS_TEXT("123456")).toBe("ETNARA Care: tu código es 123456. Vence en 10 minutos. No lo compartas.\n\n@app.etnaracare.com #123456");
  });
});

describe("providers", () => {
  it("the test provider never runs in production; nothing is enabled by default", () => {
    expect(provider).toMatch(/if \(env\.SMS_PROVIDER === "test"\) return env\.NODE_ENV === "production" \? null : testProvider;/);
    expect(readFileSync("src/config/env.ts", "utf8")).toMatch(/PHONE_VERIFICATION_ENABLED: z\.enum\(\["true", "false"\]\)\.default\("false"\)/);
    expect(readFileSync("src/config/env.ts", "utf8")).toMatch(/SMS_PROVIDER: z\.enum\(\["disabled", "test", "twilio_verify"\]\)\.default\("disabled"\)/);
  });

  it("Twilio Verify adapter: send and check against the public REST API (fake, nothing contacted)", async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).Authorization) });
      if (url.endsWith("/VerificationCheck")) {
        const code = new URLSearchParams(String(init.body)).get("Code");
        return new Response(JSON.stringify({ status: code === "123456" ? "approved" : "pending" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }) as unknown as typeof fetch;
    const p = twilioVerifyProvider({ accountSid: `AC${"0".repeat(32)}`, authToken: "x".repeat(32), serviceSid: `VA${"1".repeat(32)}` }, fake);
    await p.send("+17875550101", null);
    expect(await p.check!("+17875550101", "123456")).toBe(true);
    expect(await p.check!("+17875550101", "000000")).toBe(false);
    expect(calls[0].url).toBe(`https://verify.twilio.com/v2/Services/VA${"1".repeat(32)}/Verifications`);
    expect(new URLSearchParams(calls[0].body).get("Channel")).toBe("sms");
    expect(new URLSearchParams(calls[0].body).get("To")).toBe("+17875550101");
    expect(calls[0].auth).toMatch(/^Basic /);
    expect(p.ownCodes).toBe(false);
  });
});

describe("migration 117", () => {
  it("only definer functions reach codes, limits and history; app_runtime has no table rights", () => {
    expect(m117).toMatch(/REVOKE ALL ON account_phone_challenges, sms_send_log, account_security_events FROM app_runtime;/);
    expect(m117).not.toMatch(/GRANT [A-Z, ]+ ON (TABLE )?(account_phone_challenges|sms_send_log|account_security_events)/);
    expect(m117).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });
  it("recovery only for the VERIFIED number, active account, no change in the last 72 h", () => {
    const start = m117.slice(m117.indexOf("FUNCTION app_phone_reset_start"), m117.indexOf("REVOKE ALL ON FUNCTION app_phone_reset_start"));
    for (const needle of ["phone = p_phone", "phone_verified_at IS NOT NULL", "status = 'active'", "phone_changed_at < now() - interval '72 hours'"]) expect(start).toContain(needle);
  });
  it("a phone change requires the password within 10 minutes in the same session", () => {
    expect(m117).toMatch(/reauthenticated_at > now\(\) - interval '10 minutes'/);
  });
  it("limits counted on the number and IP whether or not an account exists", () => {
    const rate = m117.slice(m117.indexOf("FUNCTION app_sms_rate_check"), m117.indexOf("REVOKE ALL ON FUNCTION app_sms_rate_check"));
    for (const needle of ["interval '60 seconds'", ">= 3", ">= 5", ">= 10", "p_daily_cap"]) expect(rate).toContain(needle);
    expect(rate).not.toMatch(/users/);
  });
  it("rollback aborts once phones were verified and never re-opens invitations to unverified phones by leaving 117 half-applied", () => {
    expect(rollback).toMatch(/phones were verified or SMS codes were issued: rollback aborted/);
    expect(rollback).toMatch(/DELETE FROM schema_migrations WHERE filename = '117_account_phone_verification\.sql'/);
  });
});

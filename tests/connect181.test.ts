import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectConfig, serviceTokenMatches } from "../src/modules/connect/connect.config.js";
import { loadSigningKey, publicKeyPem, signMessage, verifyMessage } from "../src/modules/connect/connect.signing.js";
import { newLinkCode, normalizeCode } from "../src/modules/connect/connect.codes.js";

const { privateKey } = generateKeyPairSync("ed25519");
const keyB64 = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }) as string).toString("base64");
const token = "t".repeat(48);
const env = (over: Record<string, string | undefined> = {}) => ({ CONNECT_INTEGRATION: "on", CONNECT_SIGNING_KEY: keyB64,
  CONNECT_SERVICE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"), CONNECT_WEBHOOK_URL: "https://connect.example.invalid/api/care/eventos", ...over }) as NodeJS.ProcessEnv;

describe("181 · configuración de la integración con Connect", () => {
  it("apagada salvo CONNECT_INTEGRATION=on con todas las piezas válidas", () => {
    expect(connectConfig(env())).not.toBeNull();
    expect(connectConfig(env({ CONNECT_INTEGRATION: "true" }))).toBeNull();
    expect(connectConfig(env({ CONNECT_SIGNING_KEY: "no-es-llave" }))).toBeNull();
    expect(connectConfig(env({ CONNECT_SERVICE_TOKEN_SHA256: "abc" }))).toBeNull();
    expect(connectConfig(env({ CONNECT_WEBHOOK_URL: "http://connect.example.invalid/x" }))).toBeNull();
    expect(connectConfig(env({ CONNECT_WEBHOOK_URL: "http://127.0.0.1:9/x" }))).toBeNull();
    expect(connectConfig(env({ CONNECT_WEBHOOK_URL: "http://127.0.0.1:9/x", NODE_ENV: "test" }))).not.toBeNull();
  });
  it("rechaza una llave que no sea Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(loadSigningKey(Buffer.from(rsa).toString("base64"))).toBeNull();
  });
  it("el token de servicio se compara con su huella", () => {
    const cfg = connectConfig(env())!;
    expect(serviceTokenMatches(cfg, `Bearer ${token}`)).toBe(true);
    expect(serviceTokenMatches(cfg, `Bearer ${"x".repeat(48)}`)).toBe(false);
    expect(serviceTokenMatches(cfg, token)).toBe(false);
    expect(serviceTokenMatches(cfg, undefined)).toBe(false);
    expect(serviceTokenMatches(cfg, "Bearer corto")).toBe(false);
  });
});

describe("181 · mensajes firmados", () => {
  const key = loadSigningKey(keyB64)!;
  const pem = publicKeyPem(key);
  it("firma y verifica; caduca; rechaza alteraciones y otra audiencia", () => {
    const now = Date.now();
    const t = signMessage(key, "care.org.status", { suspended: false }, now, 600);
    expect(verifyMessage<{ suspended: boolean }>(pem, t, now)?.data.suspended).toBe(false);
    expect(verifyMessage(pem, t, now + 601_000)).toBeNull();
    const [b, s] = t.split(".");
    const d = JSON.parse(Buffer.from(b, "base64url").toString()); d.data.suspended = true;
    expect(verifyMessage(pem, Buffer.from(JSON.stringify(d)).toString("base64url") + "." + s, now)).toBeNull();
    d.data.suspended = false; d.aud = "otra";
    expect(verifyMessage(pem, Buffer.from(JSON.stringify(d)).toString("base64url") + "." + s, now)).toBeNull();
    expect(verifyMessage(pem, "basura", now)).toBeNull();
  });
  it("vida máxima de 24 h", () => {
    const e = verifyMessage(pem, signMessage(key, "care.org.status", {}, Date.now(), 999_999))!;
    expect(e.exp - e.iat).toBe(86400);
  });
});

describe("181 · códigos de vínculo", () => {
  it("10 caracteres sin ambiguos, normalizables", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = newLinkCode(); expect(c).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/); seen.add(c); }
    expect(seen.size).toBe(200);
    expect(normalizeCode("abcde fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeCode("ABCDE-FGHJK")).toBe("ABCDEFGHJK");
  });
});

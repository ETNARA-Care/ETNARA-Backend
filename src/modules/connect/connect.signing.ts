import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

/**
 * 181 · Mensajes firmados de Care para Connect (Ed25519). Formato compacto: base64url(JSON) "." base64url(firma).
 * La llave privada solo vive en el servidor (CONNECT_SIGNING_KEY, PKCS#8 PEM en base64); Connect solo tiene la pública.
 * Cada mensaje lleva emisor, destinatario, tipo, emisión, vencimiento (máx. 24 h) e identificador único.
 */
export type ConnectMessageType = "care.org.status" | "care.org.event" | "care.user.assertion";
export interface ConnectEnvelope<T> { iss: "etnara-care"; aud: "etnara-connect"; typ: ConnectMessageType; iat: number; exp: number; jti: string; data: T }

const b64u = (b: Buffer) => b.toString("base64url");

export function loadSigningKey(base64Pem: string | undefined): KeyObject | null {
  if (!base64Pem) return null;
  try {
    const k = createPrivateKey(Buffer.from(base64Pem, "base64").toString("utf8"));
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch { return null; }
}

export function publicKeyPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function signMessage<T>(key: KeyObject, typ: ConnectMessageType, data: T, now = Date.now(), ttlSeconds = 24 * 3600): string {
  const env: ConnectEnvelope<T> = { iss: "etnara-care", aud: "etnara-connect", typ, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + Math.min(ttlSeconds, 24 * 3600), jti: randomUUID(), data };
  const body = b64u(Buffer.from(JSON.stringify(env), "utf8"));
  return `${body}.${b64u(sign(null, Buffer.from(body, "utf8"), key))}`;
}

/** Solo para pruebas y para documentar el contrato: la verificación real la hace Connect con la llave pública. */
export function verifyMessage<T>(publicPem: string, token: string, now = Date.now()): ConnectEnvelope<T> | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!verify(null, Buffer.from(body, "utf8"), createPublicKey(publicPem), Buffer.from(sig, "base64url"))) return null;
  const env = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConnectEnvelope<T>;
  if (env.iss !== "etnara-care" || env.aud !== "etnara-connect" || env.exp * 1000 <= now || env.exp - env.iat > 24 * 3600 || env.iat * 1000 > now + 300_000) return null;
  return env;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

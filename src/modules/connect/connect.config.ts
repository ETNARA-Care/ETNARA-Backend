import { timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { loadSigningKey, sha256Hex } from "./connect.signing.js";

/**
 * 181 · Configuración de la integración con Connect. Apagada salvo CONNECT_INTEGRATION=on (exacto) Y todas las piezas:
 *   CONNECT_SIGNING_KEY            llave privada Ed25519 (PKCS#8 PEM en base64), sellada en el alojamiento.
 *   CONNECT_SERVICE_TOKEN_SHA256   huella SHA-256 (hex) del token con que Connect llama a Care (el token no vive aquí).
 *   CONNECT_WEBHOOK_URL            https://…/api/care/eventos de Connect (avisos inmediatos).
 * Nunca se registran las llaves ni el token.
 */
export interface ConnectConfig { key: KeyObject; serviceTokenSha256: string; webhookUrl: string }

export function connectConfig(env: NodeJS.ProcessEnv = process.env): ConnectConfig | null {
  if (env.CONNECT_INTEGRATION !== "on") return null;
  const key = loadSigningKey(env.CONNECT_SIGNING_KEY);
  const hash = (env.CONNECT_SERVICE_TOKEN_SHA256 ?? "").toLowerCase();
  const url = env.CONNECT_WEBHOOK_URL ?? "";
  if (!key || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/[A-Za-z0-9/_-]*$/.test(url) && !(env.NODE_ENV === "test" && /^http:\/\/127\.0\.0\.1:\d+\//.test(url))) return null;
  return { key, serviceTokenSha256: hash, webhookUrl: url };
}

/** Compara el token de Connect con su huella sin revelar tiempos. */
export function serviceTokenMatches(cfg: ConnectConfig, authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const raw = authorization.slice(7).trim();
  if (raw.length < 32 || raw.length > 256) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(raw), "hex"), Buffer.from(cfg.serviceTokenSha256, "hex"));
}

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 173 · Hogares F4 (D4, §5 «Protección del QR y del código de 6 dígitos»). Puro: sin base de datos ni red.
 *
 * El token del QR y el código de 6 dígitos se DERIVAN con HMAC-SHA256 de un secreto del servidor sobre organización,
 * establecimiento, semana y versión (dominios distintos para QR y código). Nunca se guardan. Revocar sube la versión:
 * el código anterior se puede seguir derivando, pero deja de ser válido. La comparación es en tiempo constante.
 */
export interface CodeKey { keyId: string; secret: string }
export interface CodeRef { organizationId: string; locationId: string; weekStart: string; version: number; keyId: string }

const QR_PREFIX = "EA1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

function mac(key: CodeKey, domain: "qr" | "pin", ref: CodeRef): Buffer {
  if (key.secret.length < 32) throw new Error("ATTENDANCE_CODE_SECRET too short");
  return createHmac("sha256", key.secret)
    .update(`etnara-attendance|${domain}|${ref.keyId}|${ref.organizationId.toLowerCase()}|${ref.locationId.toLowerCase()}|${ref.weekStart}|${ref.version}`)
    .digest();
}

/** Token de 22 caracteres base64url (132 bits). */
export function qrToken(key: CodeKey, ref: CodeRef): string {
  return mac(key, "qr", ref).toString("base64url").slice(0, 22);
}

/** Código de 6 dígitos (con ceros a la izquierda). */
export function pinCode(key: CodeKey, ref: CodeRef): string {
  return String(mac(key, "pin", ref).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** Contenido del QR: identifica lugar, semana y versión. Sin sesión y autorización vigente no sirve para ponchar. */
export function qrPayload(key: CodeKey, ref: CodeRef): string {
  return [QR_PREFIX, ref.keyId, ref.locationId.toLowerCase(), ref.weekStart, String(ref.version), qrToken(key, ref)].join(".");
}

export interface ParsedQr { keyId: string; locationId: string; weekStart: string; version: number; token: string }
export function parseQrPayload(raw: unknown): ParsedQr | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const parts = raw.trim().split(".");
  if (parts.length !== 6 || parts[0] !== QR_PREFIX) return null;
  const [, keyId, locationId, weekStart, version, token] = parts;
  const v = Number(version);
  if (!KEY_ID.test(keyId) || !UUID.test(locationId) || !WEEK.test(weekStart) || !/^\d{1,6}$/.test(version) || v < 1 || !TOKEN.test(token)) return null;
  return { keyId, locationId, weekStart, version: v, token };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // Misma longitud para timingSafeEqual; si difieren, se compara contra sí mismo y se devuelve falso.
  if (x.length !== y.length) { timingSafeEqual(x, x); return false; }
  return timingSafeEqual(x, y);
}

/** Claves disponibles: la vigente (para emitir y verificar) y, si existe, la anterior (solo para verificar). */
export function codeKeys(env: { ATTENDANCE_CODE_SECRET?: string; ATTENDANCE_CODE_KEY_ID: string; ATTENDANCE_CODE_PREVIOUS_SECRET?: string; ATTENDANCE_CODE_PREVIOUS_KEY_ID?: string }):
  { current: CodeKey | null; byId: Map<string, CodeKey> } {
  const byId = new Map<string, CodeKey>();
  const current = env.ATTENDANCE_CODE_SECRET ? { keyId: env.ATTENDANCE_CODE_KEY_ID, secret: env.ATTENDANCE_CODE_SECRET } : null;
  if (env.ATTENDANCE_CODE_PREVIOUS_SECRET && env.ATTENDANCE_CODE_PREVIOUS_KEY_ID && env.ATTENDANCE_CODE_PREVIOUS_KEY_ID !== env.ATTENDANCE_CODE_KEY_ID) {
    byId.set(env.ATTENDANCE_CODE_PREVIOUS_KEY_ID, { keyId: env.ATTENDANCE_CODE_PREVIOUS_KEY_ID, secret: env.ATTENDANCE_CODE_PREVIOUS_SECRET });
  }
  if (current) byId.set(current.keyId, current);
  return { current, byId };
}

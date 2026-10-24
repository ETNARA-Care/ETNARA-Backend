import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Phone numbers: +1 only (Puerto Rico 787/939 and the US). Accepts what people
 * type — "(787) 555-1234", "787-555-1234", "+1 787 555 1234", "17875551234" —
 * and returns E.164 (+17875551234), or null when it is not a valid NANP number.
 */
export function normalizeNanpPhone(input: string): string | null {
  if (typeof input !== "string" || input.length > 32 || /[a-z@]/i.test(input)) return null;
  let digits = input.replace(/[\s().\-+]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

/** «•••-•••-1234»: the only form in which a number is ever shown back. */
export function maskPhone(e164: string | null): string | null {
  return e164 ? `•••-•••-${e164.slice(-4)}` : null;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain) return null;
  return `${user.slice(0, 1)}•••@${domain}`;
}

export function newSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** HMAC with a server secret: a 6-digit code cannot be brute-forced from its stored hash. */
export function hashCode(secret: string, purpose: string, phone: string, code: string): string {
  return createHmac("sha256", secret).update(`${purpose}\n${phone}\n${code}`).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Keyed hash for rate-limit bookkeeping: the log never holds a number or an IP in clear. */
export function lookupHash(secret: string, kind: "phone" | "ip", value: string): string {
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
}

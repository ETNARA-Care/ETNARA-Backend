/**
 * Etapa 0: límite por usuario de ETNARA Central para reenviar invitaciones (además del límite por invitación,
 * que se cuenta en audit_log dentro de la transacción). Memoria de una sola instancia, como auth.rateLimit.ts.
 */
export const CENTRAL_RESEND_WINDOW_MS = 60 * 60 * 1000;
export const CENTRAL_RESEND_LIMIT_PER_USER = 20;
const MAX_KEYS = 1_000;
const buckets = new Map<string, number[]>();

export function checkCentralResendLimit(userId: string, now = Date.now()): boolean {
  const recent = (buckets.get(userId) ?? []).filter((t) => t > now - CENTRAL_RESEND_WINDOW_MS);
  if (recent.length >= CENTRAL_RESEND_LIMIT_PER_USER) { buckets.set(userId, recent); return false; }
  buckets.delete(userId);
  buckets.set(userId, [...recent, now]);
  while (buckets.size > MAX_KEYS) { const oldest = buckets.keys().next().value; if (oldest === undefined) break; buckets.delete(oldest); }
  return true;
}

/** Tests only. */
export function resetCentralResendLimit(): void { buckets.clear(); }

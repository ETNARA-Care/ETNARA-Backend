import { sql } from "kysely";
import { env } from "../../config/env.js";
import { db } from "../../config/db.js";
import { withUserContext } from "../../context/tenantContext.js";
import { generateSessionToken } from "../../security/sessionToken.js";
import { verifyPassword } from "../../security/password.js";
import { loadEmailConfig, sendPhoneChangedEmail } from "../email/email.service.js";
import { hashCode, lookupHash, maskEmail, maskPhone, newSixDigitCode, normalizeNanpPhone, sameHash } from "./phone.js";
import { activeSmsProvider, SmsUnavailableError, type SmsProvider } from "./smsProvider.js";

/**
 * Phone linked to the account + SMS password recovery (migration 117).
 * Every rule lives in the database functions; this layer normalises input,
 * makes/checks codes and talks to the SMS provider. Off unless
 * PHONE_VERIFICATION_ENABLED=true and a provider is configured.
 */
export class AccountSecurityError extends Error {
  constructor(public code: string, public status: number) { super(code); this.name = "AccountSecurityError"; }
}

const DB_ERRORS: Record<string, number> = {
  REAUTHENTICATION_REQUIRED: 401,
  PHONE_INVALID: 400,
  PHONE_ALREADY_VERIFIED: 409,
  PHONE_UNAVAILABLE: 409,
  PHONE_FORBIDDEN: 403,
  CODE_INVALID: 400,
  SMS_RATE_LIMITED: 429,
  SESSION_NOT_FOUND: 401,
};
function mapDbError(err: unknown): never {
  const message = (err as { message?: unknown })?.message;
  const code = typeof message === "string" ? message.split(" ")[0] : "";
  if (code in DB_ERRORS) throw new AccountSecurityError(code === "SESSION_NOT_FOUND" ? "REAUTHENTICATION_REQUIRED" : code, DB_ERRORS[code]);
  throw err;
}

export function phoneFeature(): { provider: SmsProvider; secret: string } {
  const provider = activeSmsProvider();
  if (!provider || !env.PHONE_CODE_SECRET) throw new AccountSecurityError("FEATURE_NOT_ENABLED", 404);
  return { provider, secret: env.PHONE_CODE_SECRET };
}

async function asUser<T>(userId: string, fn: (trx: never) => Promise<T>): Promise<T> {
  try { return await withUserContext(userId, (trx) => fn(trx as never)); } catch (err) {
    if (err instanceof AccountSecurityError) throw err;
    return mapDbError(err);
  }
}

/** Signed out: no identity in the transaction at all (the definer functions decide everything). */
async function anonymous<T>(fn: (trx: never) => Promise<T>): Promise<T> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_user_id', '', true), set_config('app.current_org_id', '', true), set_config('app.is_superadmin', 'false', true)`.execute(trx);
      return fn(trx as never);
    });
  } catch (err) {
    if (err instanceof AccountSecurityError) throw err;
    return mapDbError(err);
  }
}

async function rateCheck(trx: never, secret: string, phone: string, ip: string | undefined, purpose: "VERIFY" | "RESET") {
  await sql`SELECT app_sms_rate_check(${lookupHash(secret, "phone", phone)}, ${ip ? lookupHash(secret, "ip", ip) : null},
    ${purpose}::account_phone_purpose, ${env.SMS_DAILY_CAP}::int)`.execute(trx);
}

// ------------------------------------------------------------------ state
export async function getAccountSecurity(userId: string) {
  const row = await asUser(userId, async (trx) => (await sql<{ email: string | null; phone: string | null; phone_verified_at: Date | null;
    phone_changed_at: Date | null; created_at: Date; staff: boolean }>`SELECT * FROM app_account_security_state()`.execute(trx)).rows[0]);
  if (!row) throw new AccountSecurityError("NOT_FOUND", 404);
  const verified = !!row.phone_verified_at;
  const since = env.PHONE_REQUIRED_SINCE ? new Date(env.PHONE_REQUIRED_SINCE) : null;
  const pausedUntil = row.phone_changed_at ? new Date(new Date(row.phone_changed_at).getTime() + 72 * 3600 * 1000) : null;
  return {
    email: maskEmail(row.email),
    phone: verified ? maskPhone(row.phone) : null,
    phoneVerified: verified,
    // Staff accounts created after the cut-off must link a phone; everyone else is only reminded.
    phoneRequired: !verified && row.staff && !!since && new Date(row.created_at) >= since,
    phoneRecommended: !verified,
    smsRecoveryAvailable: verified && (!pausedUntil || pausedUntil <= new Date()),
    smsRecoveryPausedUntil: verified && pausedUntil && pausedUntil > new Date() ? pausedUntil.toISOString() : null,
    phoneVerificationAvailable: !!activeSmsProvider(),
  };
}

// ------------------------------------------------------------------ re-authentication
export async function reauthenticate(userId: string, sessionId: string, password: string): Promise<void> {
  const hash = await asUser(userId, async (trx) =>
    (await sql<{ password_hash: string | null }>`SELECT password_hash FROM users WHERE id = ${userId} AND status = 'active'`.execute(trx)).rows[0]?.password_hash);
  if (!hash || !(await verifyPassword(password, hash))) throw new AccountSecurityError("INVALID_CREDENTIALS", 401);
  await asUser(userId, async (trx) => { await sql`SELECT app_session_mark_reauthenticated(${sessionId}::uuid)`.execute(trx); });
}

// ------------------------------------------------------------------ link / change (signed in)
export async function startPhoneVerification(userId: string, sessionId: string, rawPhone: string, ip: string | undefined): Promise<void> {
  const { provider, secret } = phoneFeature();
  const phone = normalizeNanpPhone(rawPhone);
  if (!phone) throw new AccountSecurityError("PHONE_INVALID", 400);
  const code = provider.ownCodes ? newSixDigitCode() : null;
  await asUser(userId, async (trx) => {
    await rateCheck(trx, secret, phone, ip, "VERIFY");
    await sql`SELECT app_phone_verification_start(${sessionId}::uuid, ${phone}, ${code ? hashCode(secret, "VERIFY", phone, code) : null}, ${provider.name})`.execute(trx);
  });
  try { await provider.send(phone, code); } catch { throw new AccountSecurityError("SMS_UNAVAILABLE", 503); }
}

export async function confirmPhoneVerification(userId: string, rawCode: string): Promise<{ result: "VERIFIED" | "CHANGED"; last4: string }> {
  const { provider, secret } = phoneFeature();
  const code = /^\d{6}$/.test(rawCode) ? rawCode : "000000x";
  const attempt = await asUser(userId, async (trx) => (await sql<{ challenge_id: string; code_hash: string | null; phone: string }>`
    SELECT * FROM app_phone_challenge_attempt('VERIFY'::account_phone_purpose, NULL)`.execute(trx)).rows[0]);
  const ok = await checkCode(provider, secret, "VERIFY", attempt.phone, attempt.code_hash, code);
  if (!ok) {
    await asUser(userId, async (trx) => { await sql`SELECT app_phone_challenge_failed(${attempt.challenge_id}::uuid)`.execute(trx); });
    throw new AccountSecurityError("CODE_INVALID", 400);
  }
  const result = await asUser(userId, async (trx) =>
    (await sql<{ r: "VERIFIED" | "CHANGED" }>`SELECT app_phone_verification_complete(${attempt.challenge_id}::uuid) AS r`.execute(trx)).rows[0].r);
  const last4 = attempt.phone.slice(-4);
  if (result === "CHANGED") {
    // Notice to the account's e-mail (best effort; never blocks the change).
    const email = await asUser(userId, async (trx) => (await sql<{ email: string | null }>`SELECT email FROM app_account_security_state()`.execute(trx)).rows[0]?.email);
    if (email) void sendPhoneChangedEmail(email, last4, loadEmailConfig()).catch(() => undefined);
  }
  return { result, last4 };
}

async function checkCode(provider: SmsProvider, secret: string, purpose: string, phone: string, codeHash: string | null, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  if (provider.ownCodes) return !!codeHash && sameHash(codeHash, hashCode(secret, purpose, phone, code));
  try { return await provider.check!(phone, code); } catch (err) {
    if (err instanceof SmsUnavailableError) throw new AccountSecurityError("SMS_UNAVAILABLE", 503);
    throw err;
  }
}

// ------------------------------------------------------------------ SMS password recovery (signed out)
/**
 * Synchronous part: input + limits (counted on the number whether or not it has
 * an account, so 429 reveals nothing). Returns the work to run AFTER answering.
 */
export async function beginSmsReset(rawPhone: string, ip: string | undefined): Promise<(() => Promise<void>) | null> {
  const { provider, secret } = phoneFeature();
  const phone = normalizeNanpPhone(rawPhone);
  if (!phone) throw new AccountSecurityError("PHONE_INVALID", 400);
  await anonymous(async (trx) => { await rateCheck(trx, secret, phone, ip, "RESET"); });
  return async () => {
    const code = provider.ownCodes ? newSixDigitCode() : null;
    const send = await anonymous(async (trx) => (await sql<{ ok: boolean }>`
      SELECT app_phone_reset_start(${phone}, ${code ? hashCode(secret, "RESET", phone, code) : null}, ${provider.name}) AS ok`.execute(trx)).rows[0].ok);
    // Only the account's own verified number ever receives a code.
    if (send) await provider.send(phone, code);
  };
}

/** Correct code → a 10-minute, single-use reset token for the existing confirm step. Any failure looks the same. */
export async function verifySmsReset(rawPhone: string, rawCode: string): Promise<string> {
  const { provider, secret } = phoneFeature();
  const phone = normalizeNanpPhone(rawPhone);
  if (!phone || !/^\d{6}$/.test(rawCode)) throw new AccountSecurityError("CODE_INVALID", 400);
  const attempt = await anonymous(async (trx) => (await sql<{ challenge_id: string; code_hash: string | null; phone: string }>`
    SELECT * FROM app_phone_challenge_attempt('RESET'::account_phone_purpose, ${phone})`.execute(trx)).rows[0]);
  if (!(await checkCode(provider, secret, "RESET", attempt.phone, attempt.code_hash, rawCode))) {
    await anonymous(async (trx) => { await sql`SELECT app_phone_challenge_failed(${attempt.challenge_id}::uuid)`.execute(trx); });
    throw new AccountSecurityError("CODE_INVALID", 400);
  }
  const { rawToken, tokenHash } = generateSessionToken();
  await anonymous(async (trx) => { await sql`SELECT app_phone_reset_complete(${attempt.challenge_id}::uuid, ${tokenHash})`.execute(trx); });
  return rawToken;
}

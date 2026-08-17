import { randomBytes, createHash } from "node:crypto";

/**
 * rawToken -> sent to the client exactly once, never stored.
 * tokenHash -> the only thing persisted in sessions.token_hash.
 * On every subsequent request, the client's rawToken is re-hashed and
 * compared against the stored hash -- the raw value never touches the DB.
 */
export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("hex"); // 256 bits of entropy
  return { rawToken, tokenHash: hashToken(rawToken) };
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

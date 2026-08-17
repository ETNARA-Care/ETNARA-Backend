import { sql } from "kysely";
import {
  withLoginLookupContext,
  withTokenLookupContext,
  withUserContext,
} from "../../context/tenantContext.js";
import { hashPassword, verifyPassword } from "../../security/password.js";
import { generateSessionToken, hashToken } from "../../security/sessionToken.js";
import { env } from "../../config/env.js";

export class InvalidCredentialsError extends Error {
  constructor() {
    super("INVALID_CREDENTIALS");
    this.name = "InvalidCredentialsError";
  }
}
export class SessionInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionInvalidError";
  }
}

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  status: string;
}

// A fixed dummy hash used only to keep verifyPassword's timing profile
// similar whether or not the account exists -- a basic mitigation against
// using response timing to enumerate valid emails/phones.
const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

async function findUserByIdentifier(identifier: string): Promise<UserRow | null> {
  return withLoginLookupContext(identifier, async (trx) => {
    const result = await sql<UserRow>`
      SELECT id, email, phone, password_hash, status
      FROM users
      WHERE lower(email) = ${identifier} OR phone = ${identifier}
      LIMIT 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}

export interface LoginResult {
  token: string;
  userId: string;
  expiresAt: Date;
}

export async function login(
  identifierRaw: string,
  password: string,
  meta: { ipAddress?: string | null; deviceMetadata?: unknown } = {}
): Promise<LoginResult> {
  const identifier = identifierRaw.trim().toLowerCase();
  const user = await findUserByIdentifier(identifier);

  // Same generic failure and same rough timing profile whether the account
  // doesn't exist, has no password set, the password is wrong, or the
  // account is disabled -- never reveal which case occurred.
  if (!user || !user.password_hash) {
    await verifyPassword(password, DUMMY_HASH);
    throw new InvalidCredentialsError();
  }
  const validPassword = await verifyPassword(password, user.password_hash);
  if (!validPassword) throw new InvalidCredentialsError();
  if (user.status !== "active") throw new InvalidCredentialsError();

  const { rawToken, tokenHash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_DURATION_HOURS * 3600 * 1000);

  await withUserContext(user.id, async (trx) => {
    await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, device_metadata)
      VALUES (
        ${user.id},
        ${tokenHash},
        ${expiresAt.toISOString()},
        ${meta.ipAddress ?? null},
        ${meta.deviceMetadata ? JSON.stringify(meta.deviceMetadata) : null}
      )
    `.execute(trx);
  });

  return { token: rawToken, userId: user.id, expiresAt };
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ValidatedSession {
  userId: string;
  sessionId: string;
}

export async function validateSessionToken(rawToken: string): Promise<ValidatedSession> {
  const tokenHash = hashToken(rawToken);

  const session = await withTokenLookupContext(tokenHash, async (trx) => {
    const result = await sql<SessionRow>`
      SELECT id, user_id, expires_at, revoked_at
      FROM sessions
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `.execute(trx);
    return result.rows[0] ?? null;
  });

  if (!session) throw new SessionInvalidError("SESSION_NOT_FOUND");
  if (session.revoked_at) throw new SessionInvalidError("SESSION_REVOKED");
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new SessionInvalidError("SESSION_EXPIRED");
  }

  // Re-check the user's current status on every request -- never trust a
  // snapshot taken at login time, since status can change afterward.
  const userActive = await withUserContext(session.user_id, async (trx) => {
    const result = await sql<{ status: string }>`
      SELECT status FROM users WHERE id = ${session.user_id} LIMIT 1
    `.execute(trx);
    return result.rows[0]?.status === "active";
  });
  if (!userActive) throw new SessionInvalidError("USER_INACTIVE");

  // last_seen_at strategy: only write when the existing value is missing or
  // more than 5 minutes stale. Updating on literally every request would
  // turn every authenticated call into a write, which is unnecessary write
  // amplification for an MVP -- a 5-minute granularity is more than enough
  // to answer "is this session actually in use" without that cost. Runs
  // fire-and-forget so it never adds latency to the response.
  touchLastSeen(session).catch(() => {});

  return { userId: session.user_id, sessionId: session.id };
}

async function touchLastSeen(session: SessionRow): Promise<void> {
  await withUserContext(session.user_id, async (trx) => {
    await sql`
      UPDATE sessions
      SET last_seen_at = now()
      WHERE id = ${session.id}
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')
    `.execute(trx);
  });
}

export async function logout(sessionId: string, userId: string): Promise<void> {
  await withUserContext(userId, async (trx) => {
    await sql`
      UPDATE sessions
      SET revoked_at = now()
      WHERE id = ${sessionId} AND user_id = ${userId}
    `.execute(trx);
  });
}

// Re-exported for fixtures/tests that need to create demo users with a
// real hashed password rather than plaintext.
export { hashPassword };

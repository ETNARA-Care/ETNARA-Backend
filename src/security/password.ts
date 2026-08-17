import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * DECISION: scrypt via Node's built-in `crypto` module, not bcrypt/argon2.
 *
 * Rationale: bcrypt and argon2 both require native (C/C++) bindings compiled
 * at install time, which is a real source of fragility in constrained/CI
 * sandboxes (exactly the kind of environment this was built and tested in).
 * Node's crypto.scrypt is part of the standard library, needs no native
 * compilation step, and is explicitly recommended by OWASP as an acceptable
 * password-hashing KDF alongside bcrypt/argon2.
 *
 * SECURITY FIX (post-review): N/r/p are now explicit constants passed
 * directly to scrypt() -- never relying on Node's implicit defaults, which
 * are not guaranteed stable across Node versions. They are also ENCODED
 * INTO the stored hash string itself, so every stored password is
 * self-describing: verification always uses the exact parameters that
 * were active when that specific hash was created, never "whatever the
 * current constants happen to be". This is what makes a future cost
 * increase possible without breaking existing hashes (see needsRehash()).
 */
const CURRENT_PARAMS = { N: 16384, r: 8, p: 1 } as const; // N=2^14, OWASP 2023+ baseline minimum
const MAXMEM = 64 * 1024 * 1024; // must be >= 128*N*r*p bytes; 128*16384*8*1 = 16MiB, so 64MiB gives headroom
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function encodeParams(p: { N: number; r: number; p: number }): string {
  return `N=${p.N},r=${p.r},p=${p.p}`;
}
function decodeParams(s: string): { N: number; r: number; p: number } {
  const out: Record<string, number> = {};
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=");
    out[k] = Number.parseInt(v, 10);
  }
  return { N: out.N, r: out.r, p: out.p };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH, { ...CURRENT_PARAMS, maxmem: MAXMEM });
  // Format: scrypt$N=...,r=...,p=...$saltHex$hashHex -- self-describing,
  // so parameters can change going forward without invalidating old hashes.
  return `scrypt$${encodeParams(CURRENT_PARAMS)}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const params = decodeParams(parts[1]);
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  const derivedKey = await scryptAsync(password, salt, expected.length, { ...params, maxmem: MAXMEM });
  if (derivedKey.length !== expected.length) return false;
  return timingSafeEqual(derivedKey, expected);
}

/**
 * Upgrade path (section 9): after a SUCCESSFUL login, the caller can check
 * needsRehash(storedHash) -- if the hash was created with older/weaker
 * parameters than CURRENT_PARAMS, rehash with hashPassword() and overwrite
 * users.password_hash. Not wired into login() automatically yet (not
 * requested), but the format already supports it without any migration.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return true;
  const params = decodeParams(parts[1]);
  return (
    params.N !== CURRENT_PARAMS.N || params.r !== CURRENT_PARAMS.r || params.p !== CURRENT_PARAMS.p
  );
}

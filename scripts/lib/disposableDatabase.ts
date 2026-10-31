/**
 * Guard for scripts that create or reset demo accounts (seedDemo, repairDemoAccess,
 * createMinimalCaregiverDemo). They must only ever touch a disposable local database:
 * in production they would create or reset @demo.etnara.care accounts with a password
 * someone knows (audit 26-oct-2026, B2).
 *
 * Every rule must pass; each one alone blocks production:
 *   1. ETNARA_DISPOSABLE_DB=true is set explicitly.
 *   2. NODE_ENV is not "production".
 *   3. Not running inside Railway (no RAILWAY_* variables, which `railway run` and
 *      Railway services inject).
 *   4. The database host is local: localhost, 127.0.0.1, ::1, a Unix socket, or a
 *      single-label Docker/CI service name. Hosted providers are always refused.
 *   5. The demo password comes from DEMO_PASSWORD and has at least 16 characters, so the
 *      short password that was published can never be written again.
 */

const HOSTED = /(railway|rlwy\.net|amazonaws|supabase|neon\.tech|render\.com|herokuapp|azure|googleapis|digitalocean)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const MIN_DEMO_PASSWORD_LENGTH = 16;

export class DisposableDatabaseError extends Error {
  constructor(reason: string) {
    super(`This demo script only runs against a disposable local database: ${reason}`);
    this.name = "DisposableDatabaseError";
  }
}

/** Host of a postgres connection string; "" for a Unix socket. Throws on unparsable input. */
export function databaseHost(connectionString: string): string {
  // postgres://user@/db?host=/var/run/postgresql (Unix socket; not a valid WHATWG URL)
  if (/^postgres(?:ql)?:\/\/[^@/]*@\/[^?]*\?(?:[^#]*&)?host=\/[^&#]*/i.test(connectionString)) return "";
  const url = new URL(connectionString);
  const socket = url.searchParams.get("host");
  if (!url.hostname && socket) return socket.startsWith("/") ? "" : socket;
  return url.hostname;
}

export function assertDisposableDatabase(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.ETNARA_DISPOSABLE_DB !== "true") throw new DisposableDatabaseError("ETNARA_DISPOSABLE_DB=true is not set");
  if (env.NODE_ENV === "production") throw new DisposableDatabaseError("NODE_ENV=production");
  const railway = Object.keys(env).filter((k) => k.startsWith("RAILWAY_"));
  if (railway.length > 0) throw new DisposableDatabaseError("running inside Railway (RAILWAY_* variables present)");
  if (!connectionString) throw new DisposableDatabaseError("no database connection string");
  if (HOSTED.test(connectionString)) throw new DisposableDatabaseError("hosted database refused");
  let host: string;
  try { host = databaseHost(connectionString); } catch { throw new DisposableDatabaseError("connection string is not a valid URL"); }
  const local = host === "" || LOCAL_HOSTS.has(host.toLowerCase()) || /^[a-z0-9_-]+$/i.test(host);
  if (!local) throw new DisposableDatabaseError(`database host "${host}" is not local`);
}

export function demoPasswordFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.DEMO_PASSWORD;
  if (!password || password.length < MIN_DEMO_PASSWORD_LENGTH) {
    throw new DisposableDatabaseError(`DEMO_PASSWORD with at least ${MIN_DEMO_PASSWORD_LENGTH} characters is required`);
  }
  return password;
}

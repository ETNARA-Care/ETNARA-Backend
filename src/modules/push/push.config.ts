import { env } from "../../config/env.js";

/**
 * Web Push (146). Sending happens only when PUSH_ENABLED=on AND the three VAPID values are
 * present. Never logs the keys; the private key is read only here.
 */
export interface VapidDetails { subject: string; publicKey: string; privateKey: string }

export function pushVapidDetails(): VapidDetails | null {
  if (env.PUSH_ENABLED !== "on") return null;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

export function pushPublicConfig(): { enabled: boolean; publicKey: string | null } {
  const vapid = pushVapidDetails();
  return { enabled: vapid !== null, publicKey: vapid?.publicKey ?? null };
}

/** Where /abrir lives (the portal). */
export function pushAppBaseUrl(): string { return env.PUSH_APP_BASE_URL; }

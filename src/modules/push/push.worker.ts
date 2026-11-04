import { sql } from "kysely";
import webpush from "web-push";
import { db } from "../../config/db.js";
import { pushAppBaseUrl, pushVapidDetails, type VapidDetails } from "./push.config.js";
import { buildPushPayload } from "./pushPayload.js";

/**
 * Web Push sender (146). Runs without a request context (app_runtime, background functions
 * only). Each tick: queued notices → one delivery per phone → access re-checked in the
 * database → encrypted send (RFC 8291, VAPID RFC 8292) → result recorded. 404/410 removes the
 * phone; 429/5xx retries with backoff; nothing older than 24 h is sent.
 *
 * Logs carry counts and status classes only: never an endpoint, key, notice id or text.
 */
export interface PushJob {
  delivery_id: string; notification_id: string; endpoint: string; p256dh: string; auth: string;
  title: string; body: string; ttl_seconds: number; urgency: "normal" | "high";
}

/** Sends one encrypted message; resolves to the push service's HTTP status (0 = no answer). */
export type PushSender = (job: PushJob, payload: string, vapid: VapidDetails) => Promise<number>;

export const webPushSender: PushSender = async (job, payload, vapid) => {
  try {
    const r = await webpush.sendNotification(
      { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
      payload,
      { TTL: job.ttl_seconds, urgency: job.urgency, vapidDetails: vapid, timeout: 10_000, contentEncoding: "aes128gcm" },
    );
    return r.statusCode;
  } catch (error) {
    const status = (error as { statusCode?: unknown })?.statusCode;
    return typeof status === "number" ? status : 0;
  }
};

export interface PushTickResult { expanded: number; sent: number; retry: number; gone: number; failed: number }

export async function runPushTick(sender: PushSender = webPushSender, vapid: VapidDetails | null = pushVapidDetails()): Promise<PushTickResult> {
  const result: PushTickResult = { expanded: 0, sent: 0, retry: 0, gone: 0, failed: 0 };
  if (!vapid) return result;
  result.expanded = Number((await sql<{ n: number }>`SELECT app_push_expand(200) AS n`.execute(db)).rows[0]?.n ?? 0);
  const jobs = (await sql<PushJob>`SELECT * FROM app_push_claim(50)`.execute(db)).rows;
  const CONCURRENCY = 8;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + CONCURRENCY).map(async (job) => {
      const status = await sender(job, buildPushPayload(job, pushAppBaseUrl()), vapid);
      const outcome = (await sql<{ o: string }>`SELECT app_push_report(${job.delivery_id}::uuid, ${status}) AS o`.execute(db)).rows[0]?.o;
      if (outcome === "SENT") result.sent++;
      else if (outcome === "RETRY") result.retry++;
      else if (outcome === "GONE") result.gone++;
      else if (outcome === "FAILED") result.failed++;
    }));
  }
  return result;
}

export async function runPushCleanup(): Promise<Record<string, number>> {
  return (await sql<{ r: Record<string, number> }>`SELECT app_push_cleanup() AS r`.execute(db)).rows[0]?.r ?? {};
}

const TICK_MS = 5_000;
const CLEANUP_MS = 15 * 60_000;
const isMissingFunction = (e: unknown) => (e as { code?: string })?.code === "42883";

export function startPushWorker(sender: PushSender = webPushSender): () => void {
  const vapid = pushVapidDetails();
  if (!vapid) return () => undefined;
  let running = false;
  let lastCleanup = 0;
  let warned = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runPushTick(sender, vapid);
      if (r.sent + r.retry + r.gone + r.failed > 0) console.log(`PUSH_TICK ${JSON.stringify(r)}`);
      if (Date.now() - lastCleanup > CLEANUP_MS) {
        lastCleanup = Date.now();
        const c = await runPushCleanup();
        if (Object.values(c).some((n) => n > 0)) console.log(`PUSH_CLEANUP ${JSON.stringify(c)}`);
      }
    } catch (error) {
      if (isMissingFunction(error)) { if (!warned) { warned = true; console.error("PUSH_UNAVAILABLE", { reason: "migration not applied yet" }); } }
      else { const f = error as { name?: string; code?: string }; console.error("PUSH_TICK failed", { name: f.name ?? "Error", code: f.code ?? "UNKNOWN" }); }
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

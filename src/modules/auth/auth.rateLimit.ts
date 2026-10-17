import type { Request, Response } from "express";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 10_000;
// Single-instance memory store. Move to Postgres or Redis before scaling to multiple instances.
const buckets = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const values = (buckets.get(key) ?? []).filter(t => t > now - WINDOW_MS);
  if (values.length) buckets.set(key, values);
  else buckets.delete(key);
  return values;
}

export function cleanupExpired(now = Date.now()): void {
  for (const key of buckets.keys()) recent(key, now);
  evictOverflow();
}

// Map keeps insertion order, so the first keys are the oldest. O(1) per eviction (no sort).
function evictOverflow(): void {
  while (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}
setInterval(() => cleanupExpired(), 5 * 60 * 1000).unref();

function add(key: string, now: number): void {
  const values = [...recent(key, now), now];
  buckets.delete(key); // re-insert so the most recently active keys stay at the end
  buckets.set(key, values);
  evictOverflow();
}

export function checkLimit(req: Request, res: Response, identifier?: string): boolean {
  const now = Date.now();
  const keys: [string, number][] = [[`ip:${req.ip ?? "unknown"}`, 50]];
  if (identifier) keys.push([`id:${identifier.trim().toLowerCase()}`, 5]);
  let wait = 0;
  for (const [key, limit] of keys) {
    const values = recent(key, now);
    if (values.length >= limit) wait = Math.max(wait, Math.ceil((values[0] + WINDOW_MS - now) / 1000));
  }
  if (wait > 0) {
    res.setHeader("Retry-After", String(wait));
    res.status(429).json({ error: "TOO_MANY_ATTEMPTS" });
    return false;
  }
  return true;
}

export function recordAttempt(req: Request, identifier?: string, failed = true): void {
  const now = Date.now();
  if (failed) {
    add(`ip:${req.ip ?? "unknown"}`, now);
    if (identifier) add(`id:${identifier.trim().toLowerCase()}`, now);
  } else if (identifier) {
    buckets.delete(`id:${identifier.trim().toLowerCase()}`);
  }
}

export function resetLimitsForTests(): void { buckets.clear(); }
export function rateLimitKeyCountForTests(): number { return buckets.size; }

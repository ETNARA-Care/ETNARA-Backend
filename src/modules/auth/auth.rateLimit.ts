import type { Request, Response } from "express";

const WINDOW_MS = 15 * 60 * 1000;
// Single-instance memory store. Move to Postgres or Redis before scaling to multiple instances.
const buckets = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const values = (buckets.get(key) ?? []).filter(t => t > now - WINDOW_MS);
  if (values.length) buckets.set(key, values);
  else buckets.delete(key);
  return values;
}

export function checkLimit(req: Request, res: Response, identifier?: string): boolean {
  const now = Date.now();
  const keys: [string, number][] = [[`ip:${req.ip ?? "unknown"}`, 20]];
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
  const ipKey = `ip:${req.ip ?? "unknown"}`;
  buckets.set(ipKey, [...recent(ipKey, now), now]);
  if (identifier) {
    const key = `id:${identifier.trim().toLowerCase()}`;
    if (failed) buckets.set(key, [...recent(key, now), now]);
    else buckets.delete(key);
  }
}

export function resetLimitsForTests(): void { buckets.clear(); }

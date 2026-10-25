import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-session write limit for the SmartMatch / service-location / arrival /
 * «En camino» routes (security audit L4). Existing routes are untouched so the
 * caregiver's offline queue can still flush in a burst. Single-instance memory
 * store, same caveat as auth.rateLimit.ts: move to Postgres/Redis before
 * running more than one replica.
 */
const WINDOW_MS = 60_000;
const LIMIT = 120;
const MAX_KEYS = 10_000;
const PATTERN = /\/(smartmatch|service-locations|service-location-options|location-change-requests|family-location-permissions|arrival|journey|activity-photos|photo-consents|finance)(\/|$)|\/confirm-gps$|\/care-events\/[^/]+\/photo$/;
const hits = new Map<string, number[]>();

export function featureWriteLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "OPTIONS" || !PATTERN.test(req.path)) { next(); return; }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) { next(); return; } // requireAuth answers 401 later
  const key = createHash("sha256").update(auth.slice(7)).digest("hex").slice(0, 24);
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= LIMIT) {
    res.setHeader("Retry-After", String(Math.ceil((recent[0] + WINDOW_MS - now) / 1000)));
    res.status(429).json({ error: "TOO_MANY_REQUESTS" });
    return;
  }
  recent.push(now);
  hits.delete(key); hits.set(key, recent);
  while (hits.size > MAX_KEYS) { const oldest = hits.keys().next().value; if (oldest === undefined) break; hits.delete(oldest); }
  next();
}
export function resetFeatureWriteLimitForTests(): void { hits.clear(); }

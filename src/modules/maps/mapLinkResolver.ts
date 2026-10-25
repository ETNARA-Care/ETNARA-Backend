/**
 * Expands a SHORT map link (Google «maps.app.goo.gl», «goo.gl/maps», Apple «maps.apple/p/…»)
 * to read the coordinates of its destination. Only these links need it: every other
 * link is interpreted on the phone (mapLinks.ts) and never reaches the server.
 *
 * Privacy and safety (reviewed for Gate 6 «Pegar ubicación»):
 *  - only the opaque code that the provider itself generated travels to that same
 *    provider; no address, name, ETNARA id or cookie is ever sent;
 *  - fixed allowlist of hosts on EVERY hop, https only, no credentials or ports,
 *    redirects followed by hand (max 5), 4 s per hop, the body is never read;
 *  - Google's EU consent page (the backend runs in Amsterdam) is not followed: its
 *    «continue» target is read and validated like any other hop;
 *  - returns only a point inside Puerto Rico (and a short place name), never the URL;
 *  - nothing about the link is logged; a per-user limit protects the providers;
 *  - MAP_LINK_RESOLVER=off turns it off (the screen then asks for the full link).
 */
import { inPuertoRico, isShortMapLink, pointFromMapUrl, sourceOf, type MapPoint } from "./mapLinks.js";

export type ResolveResult =
  | { status: "point"; point: MapPoint; placeHint: string | null }
  | { status: "no-point" | "outside-pr" | "unsupported" | "unreachable" | "disabled" };

const HOP_HOSTS = new Set([
  "maps.app.goo.gl", "goo.gl", "www.google.com", "google.com", "maps.google.com", "consent.google.com",
  "www.google.com.pr", "google.com.pr", "maps.google.com.pr", "maps.apple", "maps.apple.com",
]);
const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 4_000;

function safeHop(raw: string, base: URL): URL | null {
  let next: URL;
  try { next = new URL(raw, base); } catch { return null; }
  if (next.protocol !== "https:" || next.username || next.password || next.port || !HOP_HOSTS.has(next.hostname)) return null;
  // Google's consent interstitial carries the real destination in «continue»: read it, never load the page.
  if (next.hostname === "consent.google.com") {
    const target = next.searchParams.get("continue");
    return target ? safeHop(target, next) : null;
  }
  return next;
}

export async function resolveShortMapLink(raw: string, fetchImpl: typeof fetch = fetch): Promise<ResolveResult> {
  if ((process.env.MAP_LINK_RESOLVER ?? "on").toLowerCase() === "off") return { status: "disabled" };
  let url: URL;
  try { url = new URL(raw); } catch { return { status: "unsupported" }; }
  if (!isShortMapLink(url)) return { status: "unsupported" };

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const source = sourceOf(url);
    if (source && !isShortMapLink(url) && source !== "waze") {
      const { point, placeHint } = pointFromMapUrl(url, source);
      if (point) return inPuertoRico(point) ? { status: "point", point, placeHint } : { status: "outside-pr" };
    }
    if (hop === MAX_HOPS) break;
    let res: Response;
    try {
      res = await fetchImpl(url.href, {
        method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Accept: "text/html", "User-Agent": "ETNARA-Care-link-preview/1.0" },
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch { return { status: "unreachable" }; }
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { status: "no-point" };
    const next = safeHop(location, url);
    if (!next) return { status: "unsupported" };
    url = next;
  }
  return { status: "no-point" };
}

// ------------------------------------------------------------------ per-user limit (in memory, like auth.rateLimit)
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();
export function allowResolve(userId: string, now = Date.now()): boolean {
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(userId, recent); return false; }
  recent.push(now);
  hits.set(userId, recent);
  if (hits.size > 5_000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return true;
}

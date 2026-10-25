/**
 * Map links pasted by a person (Apple Maps, Google Maps, Waze) or plain coordinates.
 *
 * Pure and dependency-free: the SAME file lives in the frontend
 * (frontend-v23/src/features/serviceLocation/mapLinks.ts) and is interpreted on
 * the phone. The backend only uses it for short links, which can only be
 * expanded by following the provider's redirect (mapLinkResolver.ts).
 *
 * Never invents a point: coordinates come only from the link or the text itself,
 * and only inside Puerto Rico. A written address is returned as a hint, never
 * turned into coordinates (no geocoding).
 */

export type MapSource = "apple" | "google" | "waze" | "coordinates";
export type MapPoint = { latitude: number; longitude: number };

export type ParsedMapInput =
  | { kind: "empty" }
  | { kind: "point"; source: MapSource; point: MapPoint; placeHint: string | null }
  /** A valid map link without coordinates: needs the server to follow the provider's redirect. */
  | { kind: "short-link"; source: "apple" | "google"; url: string; placeHint: string | null }
  /** A valid map link that names a place but carries no coordinates. */
  | { kind: "no-point"; source: MapSource; placeHint: string | null }
  | { kind: "outside-pr"; source: MapSource }
  /** A link we do not accept (other website, unsafe scheme). */
  | { kind: "unsupported-link" }
  /** Plain text that is not a link nor coordinates: a written address. */
  | { kind: "text"; text: string };

/** Puerto Rico and its islands (Mona to Culebra/Vieques): same bounds as the agency's GPS confirmation. */
export const PR_BOUNDS = { minLat: 17.5, maxLat: 18.7, minLng: -68.0, maxLng: -65.1 } as const;
export const inPuertoRico = (p: MapPoint) =>
  p.latitude >= PR_BOUNDS.minLat && p.latitude <= PR_BOUNDS.maxLat && p.longitude >= PR_BOUNDS.minLng && p.longitude <= PR_BOUNDS.maxLng;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const APPLE_HOSTS = new Set(["maps.apple.com"]);
const APPLE_SHORT_HOSTS = new Set(["maps.apple"]);
const GOOGLE_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "google.com.pr", "www.google.com.pr", "maps.google.com.pr"]);
const GOOGLE_SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const WAZE_HOSTS = new Set(["waze.com", "www.waze.com", "ul.waze.com"]);

/** The links whose final destination only the provider knows. Exported for the server resolver. */
export function isShortMapLink(url: URL): "apple" | "google" | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname === "maps.app.goo.gl" && /^\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) return "google";
  if (url.hostname === "goo.gl" && /^\/maps\/[A-Za-z0-9_-]{4,64}\/?$/.test(url.pathname)) return "google";
  if (url.hostname === "maps.apple" && /^\/p\/[A-Za-z0-9_.~-]{4,128}\/?$/.test(url.pathname)) return "apple";
  return null;
}

export function sourceOf(url: URL): MapSource | null {
  const h = url.hostname.toLowerCase();
  if (APPLE_HOSTS.has(h) || APPLE_SHORT_HOSTS.has(h)) return "apple";
  if (GOOGLE_SHORT_HOSTS.has(h)) return "google";
  if (GOOGLE_HOSTS.has(h)) return url.pathname.startsWith("/maps") || h.startsWith("maps.") ? "google" : null;
  if (WAZE_HOSTS.has(h)) return "waze";
  return null;
}

const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const pairRe = new RegExp(String.raw`^\s*${NUM}\s*[, ]\s*${NUM}\s*$`);

function point(lat: number, lng: number): MapPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: round6(lat), longitude: round6(lng) };
}
function pairFrom(value: string | null | undefined): MapPoint | null {
  if (!value) return null;
  const m = value.replace(/^ll\./, "").match(pairRe);
  return m ? point(Number(m[1]), Number(m[2])) : null;
}

/** 18°27'54.1"N 66°06'21.8"W (what Google Maps copies) — also with ″ ’ etc. */
function dmsPair(text: string): MapPoint | null {
  const part = String.raw`(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["”″]|'')?\s*([NSEWnsew])`;
  const m = text.match(new RegExp(`${part}[\\s,]+${part}`));
  if (!m) return null;
  const val = (d: string, mi: string, se: string, h: string) => (Number(d) + Number(mi) / 60 + Number(se) / 3600) * (/[SWsw]/.test(h) ? -1 : 1);
  const a = val(m[1], m[2], m[3], m[4]);
  const b = val(m[5], m[6], m[7], m[8]);
  const latFirst = /[NSns]/.test(m[4]);
  return latFirst ? point(a, b) : point(b, a);
}

/** Waze share links: https://waze.com/ul/h<geohash>. Decoded locally (cell centre). */
export function decodeGeohash(hash: string): MapPoint | null {
  const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  if (!/^[0-9b-hjkmnp-z]{5,12}$/.test(hash)) return null;
  let even = true; const lat: [number, number] = [-90, 90]; const lng: [number, number] = [-180, 180];
  for (const c of hash) {
    const cd = base32.indexOf(c);
    for (let mask = 16; mask >= 1; mask >>= 1) {
      const range = even ? lng : lat;
      const mid = (range[0] + range[1]) / 2;
      if (cd & mask) range[0] = mid; else range[1] = mid;
      even = !even;
    }
  }
  return point((lat[0] + lat[1]) / 2, (lng[0] + lng[1]) / 2);
}

const clean = (v: string | null | undefined) => {
  const t = (v ?? "").replace(/\+/g, " ").replace(/\s+/g, " ").trim();
  return t && !pairRe.test(t) && t.length <= 200 ? t : null;
};
function safeDecode(v: string) { try { return decodeURIComponent(v); } catch { return v; } }

/** Coordinates and a place name from a full (not short) map link. */
export function pointFromMapUrl(url: URL, source: MapSource): { point: MapPoint | null; placeHint: string | null } {
  const params = url.searchParams;
  const path = safeDecode(url.pathname);
  let p: MapPoint | null = null;
  let placeHint: string | null = null;
  if (source === "google") {
    const pl = path.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/) ?? url.href.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
    if (pl) p = point(Number(pl[1]), Number(pl[2]));
    for (const k of ["q", "query", "ll", "destination", "daddr", "center", "sll"]) p ??= pairFrom(params.get(k));
    const sp = path.match(/\/maps\/(?:search|place|dir\/[^/]*)\/(-?\d{1,2}\.\d+),[\s+]*(-?\d{1,3}\.\d+)/);
    if (!p && sp) p = point(Number(sp[1]), Number(sp[2]));
    const at = path.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
    if (!p && at) p = point(Number(at[1]), Number(at[2]));
    const place = path.match(/\/maps\/place\/([^/@]+)/);
    placeHint = clean(place?.[1]) ?? clean(params.get("q")) ?? clean(params.get("query"));
  } else if (source === "apple") {
    for (const k of ["coordinate", "ll", "q", "daddr", "sll", "center"]) p ??= pairFrom(params.get(k));
    placeHint = clean(params.get("address")) ?? clean(params.get("name")) ?? clean(params.get("q"));
  } else if (source === "waze") {
    for (const k of ["ll", "to", "latlng"]) p ??= pairFrom(params.get(k));
    const gh = path.match(/^\/ul\/h([0-9b-hjkmnp-z]{5,12})\/?$/);
    if (!p && gh) p = decodeGeohash(gh[1]);
    placeHint = clean(params.get("q"));
  }
  return { point: p, placeHint };
}

/** Everything a person may paste: a share text with a link, a link, coordinates or an address. */
export function parseMapInput(raw: string): ParsedMapInput {
  const input = (raw ?? "").trim().slice(0, 2000);
  if (!input) return { kind: "empty" };
  const link = input.match(/\b(?:https?:\/\/|www\.|maps\.apple\/|maps\.app\.goo\.gl\/|waze\.com\/)[^\s<>"']+/i)?.[0];
  if (!link) {
    const direct = pairFrom(input) ?? dmsPair(input);
    if (direct) return inPuertoRico(direct) ? { kind: "point", source: "coordinates", point: direct, placeHint: null } : { kind: "outside-pr", source: "coordinates" };
    if (/^(?:javascript|data|file|vbscript|blob):/i.test(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return { kind: "unsupported-link" };
    return { kind: "text", text: input.replace(/\s+/g, " ").slice(0, 200) };
  }
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`); } catch { return { kind: "unsupported-link" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unsupported-link" };
  const source = sourceOf(url);
  if (!source) return { kind: "unsupported-link" };
  url.protocol = "https:";
  // Text around the link in a share sheet («Casa de Ana↵Calle Luna 12, Caguas, PR 00725↵https://…»)
  // is what the person shared. When it has several lines, the place name before the first line with
  // a number is dropped, so the street, town and ZIP remain.
  const lines = input.replace(link, "\n").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const firstWithNumber = lines.findIndex((l) => /\d/.test(l));
  const around = clean((lines.length > 1 && firstWithNumber > 0 ? lines.slice(firstWithNumber) : lines).join(", "));
  const short = isShortMapLink(url);
  if (short) return { kind: "short-link", source: short, url: url.href, placeHint: around };
  if (APPLE_SHORT_HOSTS.has(url.hostname) || GOOGLE_SHORT_HOSTS.has(url.hostname)) return { kind: "unsupported-link" };
  const { point: p, placeHint } = pointFromMapUrl(url, source);
  // Apple's «address» parameter is a full postal address: it wins. Otherwise the shared text wins over
  // the place name inside the link («q=Casa»), which rarely carries the town.
  const hint = source === "apple" && clean(url.searchParams.get("address")) ? placeHint : around ?? placeHint;
  if (!p) return { kind: "no-point", source, placeHint: hint };
  if (!inPuertoRico(p)) return { kind: "outside-pr", source };
  return { kind: "point", source, point: p, placeHint: hint };
}

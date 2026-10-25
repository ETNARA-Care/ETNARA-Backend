import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeGeohash, parseMapInput } from "../src/modules/maps/mapLinks.js";
import { allowResolve, resolveShortMapLink } from "../src/modules/maps/mapLinkResolver.js";

// Fictional points only (public plazas): Caguas 18.2341,-66.0485 · Viejo San Juan 18.465543,-66.116789.
const CAGUAS = { latitude: 18.2341, longitude: -66.0485 };

function encodeGeohash(lat: number, lng: number, precision = 9): string {
  const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let even = true, bit = 0, ch = 0, out = "";
  const la: [number, number] = [-90, 90], ln: [number, number] = [-180, 180];
  while (out.length < precision) {
    const r = even ? ln : la; const v = even ? lng : lat; const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch |= 16 >> bit; r[0] = mid; } else r[1] = mid;
    even = !even;
    if (bit < 4) bit++; else { out += base32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

describe("parseMapInput — links people share", () => {
  it.each([
    ["Google place link (exact place wins over the map centre)", "https://www.google.com/maps/place/Plaza+de+Armas/@18.4655,-66.1172,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d18.465543!4d-66.116789", { latitude: 18.465543, longitude: -66.116789 }, "Plaza de Armas"],
    ["Google ?q=lat,lng", "https://maps.google.com/?q=18.2341,-66.0485", CAGUAS, null],
    ["Google /search/lat,+lng", "https://www.google.com/maps/search/18.234100,+-66.048500", CAGUAS, null],
    ["Google directions", "https://www.google.com/maps/dir/?api=1&destination=18.2341%2C-66.0485", CAGUAS, null],
    ["Google @ only", "https://www.google.com/maps/@18.2341,-66.0485,16z", CAGUAS, null],
    ["Apple address + ll", "https://maps.apple.com/?address=Calle%20Luna%2012,%20Caguas,%2000725&ll=18.2341,-66.0485&q=Casa", CAGUAS, "Calle Luna 12, Caguas, 00725"],
    ["Apple place coordinate", "https://maps.apple.com/place?coordinate=18.2341,-66.0485&name=Casa%20de%20Ana", CAGUAS, "Casa de Ana"],
    ["Waze ul?ll", "https://waze.com/ul?ll=18.2341%2C-66.0485&navigate=yes", CAGUAS, null],
    ["Waze live map", "https://www.waze.com/live-map/directions?to=ll.18.2341%2C-66.0485", CAGUAS, null],
    ["http is upgraded, not refused", "http://maps.google.com/?q=18.2341,-66.0485", CAGUAS, null],
  ])("%s", (_name, input, expected, hint) => {
    const r = parseMapInput(input);
    expect(r.kind).toBe("point");
    if (r.kind !== "point") return;
    expect(r.point.latitude).toBeCloseTo(expected.latitude, 5);
    expect(r.point.longitude).toBeCloseTo(expected.longitude, 5);
    if (hint) expect(r.placeHint).toBe(hint);
  });

  it("Waze share link (geohash) is decoded on the device to within metres", () => {
    const r = parseMapInput(`https://waze.com/ul/h${encodeGeohash(CAGUAS.latitude, CAGUAS.longitude)}`);
    expect(r.kind).toBe("point");
    if (r.kind !== "point") return;
    expect(Math.abs(r.point.latitude - CAGUAS.latitude)).toBeLessThan(0.0001);
    expect(Math.abs(r.point.longitude - CAGUAS.longitude)).toBeLessThan(0.0001);
    expect(decodeGeohash("!!!")).toBeNull();
  });

  it("a share text with a name and an address around the link keeps them as a hint", () => {
    const r = parseMapInput("Casa de Ana\nCalle Luna 12, Caguas\nhttps://maps.google.com/?q=18.2341,-66.0485");
    expect(r).toMatchObject({ kind: "point", source: "google", placeHint: "Casa de Ana Calle Luna 12, Caguas" });
  });

  it.each([
    ["decimal with comma", "18.2341, -66.0485"],
    ["decimal with space", "18.2341 -66.0485"],
    ["degrees, minutes, seconds (Google «copy»)", `18°14'02.8"N 66°02'54.6"W`],
  ])("plain coordinates: %s", (_n, input) => {
    const r = parseMapInput(input);
    expect(r).toMatchObject({ kind: "point", source: "coordinates" });
    if (r.kind !== "point") return;
    expect(r.point.latitude).toBeCloseTo(18.2341, 3);
    expect(r.point.longitude).toBeCloseTo(-66.0485, 3);
  });

  it("short links are recognised but never fetched on the device", () => {
    expect(parseMapInput("https://maps.app.goo.gl/AbC123xyz")).toEqual({ kind: "short-link", source: "google", url: "https://maps.app.goo.gl/AbC123xyz" });
    expect(parseMapInput("Mira: https://goo.gl/maps/AbC123xyz")).toMatchObject({ kind: "short-link", source: "google" });
    expect(parseMapInput("https://maps.apple/p/Ab.Cd-12")).toMatchObject({ kind: "short-link", source: "apple" });
  });

  it("a map link that names a place without coordinates explains itself (no invented point)", () => {
    expect(parseMapInput("https://www.google.com/maps/search/?api=1&query=Calle+Luna+Caguas")).toEqual({ kind: "no-point", source: "google", placeHint: "Calle Luna Caguas" });
    expect(parseMapInput("https://maps.apple.com/?q=Casa%20de%20Ana")).toEqual({ kind: "no-point", source: "apple", placeHint: "Casa de Ana" });
  });

  it("points outside Puerto Rico are refused", () => {
    expect(parseMapInput("40.7128, -74.0060")).toEqual({ kind: "outside-pr", source: "coordinates" });
    expect(parseMapInput("https://maps.google.com/?q=40.7128,-74.0060")).toEqual({ kind: "outside-pr", source: "google" });
  });

  it.each([
    ["another website", "https://evil.example.com/maps?q=18.2341,-66.0485"],
    ["a look-alike host", "https://maps.google.com.evil.example/?q=18.2341,-66.0485"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,hola"],
    ["goo.gl outside /maps", "https://goo.gl/AbC123xyz"],
    ["maps.apple outside /p/", "https://maps.apple/x/AbC123"],
    ["google.com outside /maps", "https://www.google.com/search?q=18.2341,-66.0485"],
  ])("unsupported: %s", (_n, input) => {
    expect(parseMapInput(input)).toEqual({ kind: "unsupported-link" });
  });

  it("written addresses are text (never turned into coordinates)", () => {
    expect(parseMapInput("Calle Luna 12, Caguas 00725")).toEqual({ kind: "text", text: "Calle Luna 12, Caguas 00725" });
    expect(parseMapInput("Apt:5 Calle Sol, Ponce")).toEqual({ kind: "text", text: "Apt:5 Calle Sol, Ponce" });
    expect(parseMapInput("   ")).toEqual({ kind: "empty" });
  });
});

describe("resolveShortMapLink — strict server-side expansion", () => {
  afterEach(() => { delete process.env.MAP_LINK_RESOLVER; });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  it("follows the provider's redirects by hand and returns only the point", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return redirect("https://www.google.com/maps/place/Casa/@18.23,-66.04,17z/data=!3d18.2341!4d-66.0485");
    }) as unknown as typeof fetch;
    const r = await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", fake);
    expect(r).toEqual({ status: "point", point: CAGUAS, placeHint: "Casa" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(JSON.stringify(calls[0].init?.headers)).not.toMatch(/cookie|authorization/i);
  });

  it("reads Google's EU consent «continue» target without loading the consent page", async () => {
    const fake = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).not.toContain("consent.google.com");
      return redirect(`https://consent.google.com/ml?continue=${encodeURIComponent("https://www.google.com/maps?q=18.2341,-66.0485")}`);
    }) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", fake)).toEqual({ status: "point", point: CAGUAS, placeHint: null });
  });

  it("Apple short link → maps.apple.com/place?coordinate=…", async () => {
    const fake = vi.fn(async () => redirect("https://maps.apple.com/place?coordinate=18.2341,-66.0485&name=Casa")) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.apple/p/Ab.Cd-12", fake)).toEqual({ status: "point", point: CAGUAS, placeHint: "Casa" });
  });

  it.each([
    ["a redirect to another host", "https://evil.example.com/maps?q=18.2341,-66.0485"],
    ["a redirect to http", "http://www.google.com/maps?q=18.2341,-66.0485"],
    ["a redirect to an internal address", "https://169.254.169.254/latest/meta-data/"],
    ["a redirect with credentials", "https://user:pass@www.google.com/maps?q=18.2341,-66.0485"],
    ["a consent page that continues elsewhere", `https://consent.google.com/ml?continue=${encodeURIComponent("https://evil.example.com/")}`],
  ])("stops at %s (never requests it)", async (_n, location) => {
    const seen: string[] = [];
    const fake = vi.fn(async (url: string | URL | Request) => { seen.push(String(url)); return redirect(location); }) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", fake)).toEqual({ status: "unsupported" });
    expect(seen).toEqual(["https://maps.app.goo.gl/AbC123xyz"]);
  });

  it("refuses anything that is not a short map link, without any request", async () => {
    const fake = vi.fn() as unknown as typeof fetch;
    for (const u of ["https://evil.example.com/x", "https://www.google.com/maps?q=1,1", "http://maps.app.goo.gl/AbC123xyz", "https://maps.app.goo.gl:8443/AbC123xyz", "nota-url"]) {
      expect(await resolveShortMapLink(u, fake)).toEqual({ status: "unsupported" });
    }
    expect(fake).not.toHaveBeenCalled();
  });

  it("gives up after 5 hops, on network errors and outside Puerto Rico; can be switched off", async () => {
    let n = 0;
    const loop = vi.fn(async () => redirect(`https://maps.app.goo.gl/Loop${++n}xyz`)) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", loop)).toEqual({ status: "no-point" });
    expect((loop as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(5);
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", down)).toEqual({ status: "unreachable" });
    const page = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", page)).toEqual({ status: "no-point" });
    const ny = vi.fn(async () => redirect("https://www.google.com/maps?q=40.7128,-74.0060")) as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", ny)).toEqual({ status: "outside-pr" });
    process.env.MAP_LINK_RESOLVER = "off";
    const never = vi.fn() as unknown as typeof fetch;
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbC123xyz", never)).toEqual({ status: "disabled" });
    expect(never).not.toHaveBeenCalled();
  });

  it("limits each person to 20 expansions every 10 minutes", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(allowResolve("user-limit-test", t0 + i)).toBe(true);
    expect(allowResolve("user-limit-test", t0 + 100)).toBe(false);
    expect(allowResolve("user-limit-test", t0 + 10 * 60_000 + 50)).toBe(true);
  });
});

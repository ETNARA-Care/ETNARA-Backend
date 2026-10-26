import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "../src/modules/billing/billingPdf";
import { LOGO_MAX_EDGE, LOGO_MAX_INPUT_BYTES, LogoImageError, processLogo } from "../src/modules/images/logoImage";

// Fictitious images only, generated in memory.
async function gradientLogo(width: number, height: number, format: "png" | "jpeg" | "webp", withAlpha = true) {
  const raw = Buffer.alloc(width * height * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = (i / width) | 0;
    raw[i * 4] = Math.min(255, (x * 255) / width + rnd() * 50) | 0;
    raw[i * 4 + 1] = ((y * 255) / height) | 0;
    raw[i * 4 + 2] = 120 + ((rnd() * 40) | 0);
    raw[i * 4 + 3] = withAlpha && ((x - width / 2) ** 2) / (width / 2.2) ** 2 + ((y - height / 2) ** 2) / (height / 2.2) ** 2 > 1 ? 0 : 255;
  }
  const img = sharp(raw, { raw: { width, height, channels: 4 } });
  return format === "png" ? img.png().toBuffer() : format === "webp" ? img.webp({ quality: 95 }).toBuffer() : img.flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer();
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof LogoImageError ? e.code : `OTHER:${(e as Error).message}`; } };

describe("Agency logo — upload up to 5 MB, one optimised PNG stored", () => {
  it("a large PNG with transparency becomes one ≤ 800 px palette PNG: same proportions, alpha kept, no metadata, light", async () => {
    const input = await gradientLogo(1900, 950, "png");
    expect(input.length).toBeGreaterThan(300 * 1024); // the old limit would have refused it
    expect(input.length).toBeLessThan(LOGO_MAX_INPUT_BYTES);
    const out = await processLogo(input);
    const meta = await sharp(out.body).metadata();
    expect([out.width, out.height]).toEqual([800, 400]);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(LOGO_MAX_EDGE);
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(meta.exif ?? meta.xmp ?? meta.iptc ?? meta.icc).toBeUndefined();
    expect(out.body.length).toBeLessThan(150 * 1024);
    const px = await sharp(out.body).ensureAlpha().raw().toBuffer();
    const alphaAt = (x: number, y: number) => px[(y * out.width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0); // transparent corner survives
    expect(alphaAt(out.width - 1, out.height - 1)).toBe(0);
    expect(alphaAt(out.width / 2, out.height / 2)).toBe(255); // opaque centre
  });

  it("accepts JPEG and WebP; a small logo is never enlarged", async () => {
    const jpeg = await processLogo(await gradientLogo(1200, 300, "jpeg", false));
    expect([jpeg.width, jpeg.height, jpeg.inputKind]).toEqual([800, 200, "jpeg"]);
    const webp = await processLogo(await gradientLogo(400, 400, "webp"));
    expect([webp.width, webp.height, webp.inputKind]).toEqual([400, 400, "webp"]);
    expect((await sharp(webp.body).metadata()).hasAlpha).toBe(true);
  });

  it("applies the phone orientation to the pixels and removes EXIF (GPS, camera)", async () => {
    const base = await gradientLogo(600, 300, "jpeg", false);
    const withExif = await sharp(base).withMetadata({ orientation: 6, exif: { IFD0: { Make: "FicticiaCam" } } }).jpeg().toBuffer();
    expect((await sharp(withExif).metadata()).orientation).toBe(6);
    const out = await processLogo(withExif);
    expect([out.width, out.height]).toEqual([300, 600]); // rotated, not distorted
    const meta = await sharp(out.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("refuses empty, over 5 MB, non-images (PDF, GIF, SVG), unreadable and tiny images with a fixed code", async () => {
    const png = await gradientLogo(200, 100, "png");
    expect(await code(processLogo(Buffer.alloc(0)))).toBe("LOGO_EMPTY");
    expect(await code(processLogo(Buffer.concat([png, Buffer.alloc(LOGO_MAX_INPUT_BYTES)])))).toBe("LOGO_TOO_LARGE");
    expect(await code(processLogo(Buffer.from("%PDF-1.4 ficticio")))).toBe("LOGO_TYPE_NOT_ALLOWED");
    expect(await code(processLogo(Buffer.from("GIF89a\x01\x00\x01\x00")))).toBe("LOGO_TYPE_NOT_ALLOWED");
    expect(await code(processLogo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBe("LOGO_TYPE_NOT_ALLOWED");
    expect(await code(processLogo(Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)])))).toBe("LOGO_UNREADABLE");
    expect(await code(processLogo(await sharp({ create: { width: 8, height: 8, channels: 4, background: "#16213D" } }).png().toBuffer()))).toBe("LOGO_TOO_SMALL");
  });

  it("the invoice PDF embeds the optimised logo with its transparency (image + soft mask)", async () => {
    const logo = (await processLogo(await gradientLogo(1900, 950, "png"))).body;
    const inv = {
      numberText: "DEMO-000001", issueDate: "2026-10-26", periodFrom: "2026-10-01", periodTo: "2026-10-31", issuedAt: "2026-10-26T15:00:00.000Z",
      issuer: { legalName: "Agencia Ficticia", tradeName: null, address: null, phone: null, email: null, merchantRegistration: null, paymentTerms: null, footerNote: null, logo },
      client: { name: "Cliente Ficticio", address: null }, notes: null, lines: [],
      totals: { subtotalCents: 0, taxes: [], exemptBaseCents: 0, totalCents: 0, exemptBases: [] },
    };
    const pdf = (await renderInvoicePdf(inv as never)).toString("latin1");
    expect(pdf).toContain("/Subtype /Image");
    expect(pdf).toContain("/SMask");
    const a = await renderInvoicePdf(inv as never), b = await renderInvoicePdf(inv as never);
    expect(a.equals(b)).toBe(true); // still deterministic with a logo
  });

  it("the permission is checked before processing; activity photos keep their own pipeline", () => {
    const svc = readFileSync("src/modules/billing/issue.service.ts", "utf8");
    const upload = svc.slice(svc.indexOf("export async function uploadLogo"));
    expect(upload.indexOf('requireCapability(trx, organizationId, "manage")')).toBeLessThan(upload.indexOf("processLogo(body)"));
    expect(svc).not.toMatch(/from "sharp"/);
    const routes = readFileSync("src/modules/billing/billing.routes.ts", "utf8");
    expect(routes).toContain('res.status(413).json({ error: "LOGO_TOO_LARGE" })');
    const mod = readFileSync("src/modules/images/logoImage.ts", "utf8");
    expect(mod).toContain('import { detectKind } from "../activityPhotos/imageSanitizer.js"');
    expect(mod).not.toMatch(/sanitizeImage/);
  });
});

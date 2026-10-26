import { createHash } from "node:crypto";
import sharp from "sharp";
import { detectKind } from "../activityPhotos/imageSanitizer.js";

/**
 * Agency logo processing (Facturación, 26-oct): PNG, JPEG or WebP up to 5 MB in,
 * ONE optimised PNG out. Reusable by any screen that needs an organisation logo.
 *
 * - The type is decided by the magic bytes, never by the declared Content-Type.
 * - The image is fully decoded and re-encoded: EXIF (GPS, camera), XMP, IPTC, ICC
 *   and trailing data are gone; orientation is applied to the pixels first.
 * - Proportions are kept (fit "inside", never enlarged) and the longest edge is at
 *   most 800 px — plenty for the 120×60 pt box of the invoice PDF and for the portal.
 * - Transparency is kept: the output is a palette PNG with alpha (typically 3–40 KB).
 * - The original upload is never stored.
 *
 * Only `detectKind` is shared with activity photos; their pipeline (JPEG, flattened)
 * is not used or changed here because it drops transparency.
 */
export const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const LOGO_MAX_EDGE = 800;
export const LOGO_MIN_EDGE = 16;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 6;

export class LogoImageError extends Error {
  constructor(readonly code: "LOGO_EMPTY" | "LOGO_TOO_LARGE" | "LOGO_TYPE_NOT_ALLOWED" | "LOGO_UNREADABLE" | "LOGO_TOO_SMALL" | "LOGO_BUSY") {
    super(code);
    this.name = "LogoImageError";
  }
}

export interface ProcessedLogo { body: Buffer; contentType: "image/png"; width: number; height: number; sha256: string; inputKind: "png" | "jpeg" | "webp" }

let active = 0;
const queue: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (queue.length >= MAX_QUEUED) throw new LogoImageError("LOGO_BUSY");
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active += 1;
  try { return await work(); } finally { active -= 1; queue.shift()?.(); }
}

export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  if (!input?.length) throw new LogoImageError("LOGO_EMPTY");
  if (input.length > LOGO_MAX_INPUT_BYTES) throw new LogoImageError("LOGO_TOO_LARGE");
  const kind = detectKind(input);
  if (kind !== "png" && kind !== "jpeg" && kind !== "webp") throw new LogoImageError("LOGO_TYPE_NOT_ALLOWED");
  return slot(async () => {
    let out: { data: Buffer; info: sharp.OutputInfo };
    try {
      out = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize({ width: LOGO_MAX_EDGE, height: LOGO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb")
        .png({ palette: true, quality: 90, effort: 7, compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new LogoImageError("LOGO_UNREADABLE");
    }
    if (out.info.width < LOGO_MIN_EDGE || out.info.height < LOGO_MIN_EDGE) throw new LogoImageError("LOGO_TOO_SMALL");
    const meta = await sharp(out.data).metadata();
    if (meta.exif || meta.xmp || meta.iptc || meta.icc) throw new LogoImageError("LOGO_UNREADABLE"); // never store metadata
    return { body: out.data, contentType: "image/png", width: out.info.width, height: out.info.height,
      sha256: createHash("sha256").update(out.data).digest("hex"), inputKind: kind };
  });
}

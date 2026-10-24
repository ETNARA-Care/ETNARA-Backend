import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Server-side image sanitising (decision: metadata removed on the server even
 * if the phone already did it). The input is identified by its magic bytes,
 * never by the declared Content-Type; it is fully decoded and re-encoded as a
 * new JPEG, so EXIF (GPS, camera, dates), XMP, IPTC, ICC and any trailing data
 * are gone. Orientation is applied to the pixels first, so the photo is not
 * rotated once the tag is removed.
 */
export class UnsupportedImageError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "UnsupportedImageError";
  }
}

export type DetectedKind = "jpeg" | "png" | "webp" | "pdf" | "heic" | "unknown";

export function detectKind(buf: Buffer): DetectedKind {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buf.toString("latin1", 8, 12))) return "heic";
  return "unknown";
}

const MAX_EDGE = 2048;
const MAX_INPUT_PIXELS = 50_000_000;

export interface SanitizedImage {
  body: Buffer;
  contentType: "image/jpeg";
  width: number;
  height: number;
  sha256: string;
}

export async function sanitizeImage(input: Buffer): Promise<SanitizedImage> {
  const kind = detectKind(input);
  if (kind === "heic") throw new UnsupportedImageError("PHOTO_HEIC_NOT_SUPPORTED");
  if (kind !== "jpeg" && kind !== "png" && kind !== "webp") throw new UnsupportedImageError("PHOTO_UNSUPPORTED_TYPE");
  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate() // apply EXIF orientation to the pixels before the tag is dropped
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new UnsupportedImageError("PHOTO_UNREADABLE");
  }
  if (out.info.width < 16 || out.info.height < 16) throw new UnsupportedImageError("PHOTO_TOO_SMALL");
  const meta = await sharp(out.data).metadata();
  if (meta.exif || meta.xmp || meta.iptc || meta.icc) throw new UnsupportedImageError("PHOTO_METADATA_NOT_REMOVED");
  return {
    body: out.data, contentType: "image/jpeg", width: out.info.width, height: out.info.height,
    sha256: createHash("sha256").update(out.data).digest("hex"),
  };
}

/** Signed consent form: PDF kept as is (no image metadata); images sanitised like photos. */
export async function sanitizeConsentForm(input: Buffer): Promise<{ body: Buffer; contentType: "application/pdf" | "image/jpeg"; sha256: string }> {
  const kind = detectKind(input);
  if (kind === "pdf") {
    return { body: input, contentType: "application/pdf", sha256: createHash("sha256").update(input).digest("hex") };
  }
  const image = await sanitizeImage(input);
  return { body: image.body, contentType: "image/jpeg", sha256: image.sha256 };
}

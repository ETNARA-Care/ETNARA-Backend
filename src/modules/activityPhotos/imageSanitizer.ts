import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import sharp from "sharp";

/**
 * Server-side image sanitising (decision: metadata removed on the server even
 * if the phone already did it). The input is identified by its magic bytes,
 * never by the declared Content-Type; it is fully decoded and re-encoded as a
 * new JPEG, so EXIF (GPS, camera, dates), XMP, IPTC, ICC and any trailing data
 * are gone. Orientation is applied to the pixels first, so the photo is not
 * rotated once the tag is removed.
 *
 * iPhone HEIC/HEIF is decoded in an isolated worker thread (libheif as
 * WebAssembly): only raw pixels come back, so the same JPEG re-encoding and
 * metadata check apply. AVIF is decoded by sharp directly.
 */
export class UnsupportedImageError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "UnsupportedImageError";
  }
}

export type DetectedKind = "jpeg" | "png" | "webp" | "pdf" | "heic" | "avif" | "unknown";

export function detectKind(buf: Buffer): DetectedKind {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.toString("latin1", 8, 12))) return "heic";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /^(avif|avis)$/.test(buf.toString("latin1", 8, 12))) return "avif";
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

const HEIC_TIMEOUT_MS = 30_000;
const HEIC_MAX_ACTIVE = 2;
const HEIC_MAX_QUEUED = 8;
let heicActive = 0;
const heicQueue: Array<() => void> = [];

interface RawPixels { width: number; height: number; pixels: Buffer }

/** Decodes HEIC in a worker; at most HEIC_MAX_ACTIVE at once, a short queue, then 503 PHOTO_BUSY. */
async function decodeHeic(input: Buffer): Promise<RawPixels> {
  if (heicActive >= HEIC_MAX_ACTIVE) {
    if (heicQueue.length >= HEIC_MAX_QUEUED) throw new UnsupportedImageError("PHOTO_BUSY");
    await new Promise<void>((resolve) => heicQueue.push(resolve));
  }
  heicActive += 1;
  try {
    return await new Promise<RawPixels>((resolve, reject) => {
      const copy = new Uint8Array(input); // the worker gets its own copy
      const worker = new Worker(new URL("./heicWorker.cjs", import.meta.url), {
        workerData: { buffer: copy, maxPixels: MAX_INPUT_PIXELS },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
        stdout: true, stderr: true, // nothing the decoder prints reaches the logs
      });
      const timer = setTimeout(() => { void worker.terminate(); reject(new UnsupportedImageError("PHOTO_UNREADABLE")); }, HEIC_TIMEOUT_MS);
      const finish = (fn: () => void) => { clearTimeout(timer); void worker.terminate(); fn(); };
      worker.once("message", (msg: { ok: boolean; code?: string; width?: number; height?: number; pixels?: Uint8Array }) => finish(() => {
        if (!msg.ok || !msg.pixels || !msg.width || !msg.height) { reject(new UnsupportedImageError(msg.code ?? "PHOTO_UNREADABLE")); return; }
        if (msg.pixels.byteLength !== msg.width * msg.height * 4) { reject(new UnsupportedImageError("PHOTO_UNREADABLE")); return; }
        resolve({ width: msg.width, height: msg.height, pixels: Buffer.from(msg.pixels.buffer, msg.pixels.byteOffset, msg.pixels.byteLength) });
      }));
      worker.once("error", () => finish(() => reject(new UnsupportedImageError("PHOTO_UNREADABLE"))));
      worker.once("exit", () => finish(() => reject(new UnsupportedImageError("PHOTO_UNREADABLE"))));
    });
  } finally {
    heicActive -= 1;
    heicQueue.shift()?.();
  }
}

export async function sanitizeImage(input: Buffer): Promise<SanitizedImage> {
  const kind = detectKind(input);
  if (kind !== "jpeg" && kind !== "png" && kind !== "webp" && kind !== "heic" && kind !== "avif") throw new UnsupportedImageError("PHOTO_UNSUPPORTED_TYPE");
  let source: sharp.Sharp;
  if (kind === "heic") {
    let raw: RawPixels;
    try {
      raw = await decodeHeic(input);
    } catch (error) {
      // "mif1" is also used by some AVIF files, which sharp reads.
      if (input.toString("latin1", 8, 12) !== "mif1" || (error as Error).message !== "PHOTO_UNREADABLE") throw error;
      raw = { width: 0, height: 0, pixels: Buffer.alloc(0) };
    }
    source = raw.width
      ? sharp(raw.pixels, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS })
      : sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate();
  } else {
    // apply EXIF orientation to the pixels before the tag is dropped
    source = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate();
  }
  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await source
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

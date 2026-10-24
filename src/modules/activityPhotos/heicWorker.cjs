"use strict";
/**
 * HEIC/HEIF (iPhone) decoder, run in a separate worker thread so a slow or
 * hostile file cannot block the API. Uses libheif compiled to WebAssembly
 * (heic-decode → libheif-js), so the decoder has no access to the file system
 * or the network. Only the pixels of the primary image are returned: EXIF,
 * XMP, GPS and any other metadata never leave this worker. libheif applies the
 * container's rotation/mirroring, so the pixels are already upright.
 */
const { parentPort, workerData } = require("node:worker_threads");
const decode = require("heic-decode");

(async () => {
  const { buffer, maxPixels } = workerData;
  const images = await decode.all({ buffer: Buffer.from(buffer) });
  try {
    if (!images.length) throw new Error("PHOTO_UNREADABLE");
    const primary = images[0];
    if (!(primary.width > 0 && primary.height > 0) || primary.width * primary.height > maxPixels) throw new Error("PHOTO_TOO_LARGE");
    const { width, height, data } = await primary.decode();
    const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    parentPort.postMessage({ ok: true, width, height, pixels }, [pixels.buffer]);
  } finally {
    images.dispose();
  }
})().catch((error) => {
  const code = /^PHOTO_[A-Z_]+$/.test(error && error.message) ? error.message : "PHOTO_UNREADABLE";
  parentPort.postMessage({ ok: false, code });
});

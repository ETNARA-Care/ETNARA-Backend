import { describe, expect, it } from "vitest";
import { classifyStorageError, freshBindAllowed } from "../src/modules/activityPhotos/storageIdentityRules.js";

describe("145 storage identity (H1)", () => {
  it("binds automatically only on a fresh deployment", () => {
    expect(freshBindAllowed({ livePhotos: 0, bucketMarker: null, bucketHasPhotos: false })).toBe(true);
    // never adopts a marker already in the bucket (another deployment's)
    expect(freshBindAllowed({ livePhotos: 0, bucketMarker: "6f1c1a2e-0000-4000-8000-000000000000", bucketHasPhotos: false })).toBe(false);
    // never binds a bucket that already holds photo objects
    expect(freshBindAllowed({ livePhotos: 0, bucketMarker: null, bucketHasPhotos: true })).toBe(false);
    // never with live photos (or an unknown count)
    expect(freshBindAllowed({ livePhotos: 3, bucketMarker: null, bucketHasPhotos: false })).toBe(false);
    expect(freshBindAllowed({ livePhotos: null, bucketMarker: null, bucketHasPhotos: false })).toBe(false);
  });
  it("classifies storage failures into fixed codes", () => {
    expect(classifyStorageError({ name: "AccessDenied" })).toBe("STORAGE_ACCESS_DENIED");
    expect(classifyStorageError({ $metadata: { httpStatusCode: 403 } })).toBe("STORAGE_ACCESS_DENIED");
    expect(classifyStorageError({ name: "NoSuchBucket" })).toBe("STORAGE_BUCKET_NOT_FOUND");
    expect(classifyStorageError({ code: "ECONNREFUSED", name: "Error" })).toBe("STORAGE_UNREACHABLE");
  });
});

import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { gatedFeatureFor } from "../src/middleware/orgFeatureRules.js";
import { detectKind, sanitizeImage, UnsupportedImageError } from "../src/modules/activityPhotos/imageSanitizer.js";

const strip = (s: string) => s.replace(/--.*$/gm, "");
const m116 = strip(readFileSync("migrations/116_activity_photos_upload_view.sql", "utf8"));
const rollback = strip(readFileSync("ops/116_activity_photos_upload_view.rollback.sql", "utf8"));
const routes = readFileSync("src/modules/activityPhotos/activityPhotos.routes.ts", "utf8");
const storage = readFileSync("src/modules/activityPhotos/photoStorage.ts", "utf8");

describe("image sanitiser (synthetic images only)", () => {
  it("identifies files by their bytes, not by the declared type", () => {
    expect(detectKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectKind(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectKind(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic0000")]))).toBe("heic");
    expect(detectKind(Buffer.from("<svg/>"))).toBe("unknown");
  });

  it("removes EXIF including GPS and camera data, and re-encodes as JPEG", async () => {
    const input = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } })
      .jpeg().withExif({ IFD0: { Make: "SyntheticCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "18/1 27/1 0/1" } }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await sanitizeImage(input);
    const meta = await sharp(out.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(out.body.toString("latin1")).not.toContain("SyntheticCam");
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects HEIC, non-images and tiny images", async () => {
    await expect(sanitizeImage(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(32)]))).rejects.toThrow("PHOTO_HEIC_NOT_SUPPORTED");
    await expect(sanitizeImage(Buffer.from("hola"))).rejects.toBeInstanceOf(UnsupportedImageError);
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(sanitizeImage(tiny)).rejects.toThrow("PHOTO_TOO_SMALL");
  });
});

describe("routes and storage", () => {
  it("every photo route is behind the ACTIVITY_PHOTOS switch", () => {
    const O = "11111111-1111-4111-8111-111111111111", X = "22222222-2222-4222-8222-222222222222";
    for (const path of [`/organizations/${O}/care-events/${X}/photo`, `/organizations/${O}/activity-photos`, `/organizations/${O}/activity-photos/${X}/image`,
      `/organizations/${O}/care-recipients/${X}/photo-consents`, `/organizations/${O}/photo-consents/${X}/revoke`]) {
      expect(gatedFeatureFor(path)?.feature).toBe("ACTIVITY_PHOTOS");
    }
  });

  it("images are streamed privately and no presigned URL or documents bucket is used", () => {
    expect(readFileSync("src/modules/activityPhotos/activityPhotos.service.ts", "utf8")).toMatch(/Cache-Control", "private, no-store, max-age=0"/);
    expect(readFileSync("src/modules/activityPhotos/activityPhotos.service.ts", "utf8")).toMatch(/X-Content-Type-Options", "nosniff"/);
    expect(storage).not.toMatch(/getSignedUrl|s3-request-presigner/);
    expect(storage).not.toMatch(/env\.STORAGE_ACCESS_KEY_ID|env\.STORAGE_SECRET_ACCESS_KEY/);
    expect(storage).toMatch(/PHOTO_STORAGE_BUCKET === env\.STORAGE_BUCKET/);
  });
});

describe("migration 116", () => {
  it("one photo per activity; storage keys only through checked functions; no grants to PUBLIC", () => {
    expect(m116).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_care_event_photos_one_per_activity ON care_event_photos \(care_event_id\)/);
    expect(m116).not.toMatch(/\bTO\s+PUBLIC\b/i);
    const view = m116.slice(m116.indexOf("FUNCTION public.app_activity_photo_for_view"), m116.indexOf("REVOKE ALL ON FUNCTION public.app_activity_photo_for_view"));
    for (const needle of ["app_is_superadmin()", "app_org_feature_enabled(v_org, 'ACTIVITY_PHOTOS')", "app_photo_is_manager()", "app_family_can_view_activity_photo(p_photo_id)", "care_event_photo_access_log"]) {
      expect(view).toContain(needle);
    }
    expect(m116).toMatch(/'activity-photos\/' \|\| v_org \|\| '\/' \|\| v_recipient \|\| '\/' \|\| p_file_id \|\| '\.jpg'/);
  });

  it("the access log is read by managers only and never written by app_runtime", () => {
    expect(m116).toMatch(/REVOKE ALL ON care_event_photo_access_log FROM app_runtime;\s+GRANT SELECT ON care_event_photo_access_log TO app_runtime;/);
    expect(m116).toMatch(/CREATE POLICY platform_phi_deny ON care_event_photo_access_log AS RESTRICTIVE/);
  });

  it("rollback keeps 115 and aborts if the feature was used", () => {
    expect(rollback).toMatch(/activity photos or views exist: rollback aborted/);
    expect(rollback).toMatch(/115 must stay applied/);
    expect(rollback).not.toMatch(/115_activity_photos_security\.sql'\s*;/);
    expect(rollback).not.toMatch(/GRANT/i);
  });
});

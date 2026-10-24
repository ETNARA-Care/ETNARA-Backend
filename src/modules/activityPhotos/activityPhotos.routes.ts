import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { InvalidTenantContextError, MembershipNotActiveError } from "../../context/errors.js";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/auth.js";
import { respondInternalError } from "../../observability/internalError.js";
import { OrganizationAccessDeniedError } from "../organizationContext/organizationContext.service.js";
import {
  consentQuerySchema, getActivityPhotoForEvent, getAgencyPhotoHistory, listAgencyPhotos, listPhotoConsents, listPhotosQuerySchema,
  PhotoError, readActivityPhoto, sendPrivateImage, readPhotoConsentForm, recordPhotoConsent, reviewActivityPhoto, reviewSchema, revokePhotoConsent, revokeSchema,
  uploadActivityPhoto,
} from "./activityPhotos.service.js";
import { UnsupportedImageError } from "./imageSanitizer.js";
import { PhotoStorageNotConfiguredError } from "./photoStorage.js";

/**
 * Activity photos (PR 2). All routes sit behind the ACTIVITY_PHOTOS switch
 * (orgFeatureGate → 404 when off) and the per-session write limit. Request
 * bodies are image bytes and are never logged; responses never carry storage
 * keys, file ids or bucket URLs.
 */
const router = Router();
const uuid = z.string().uuid();
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/octet-stream"];
const imageBody = express.raw({ type: IMAGE_TYPES, limit: env.PHOTO_MAX_UPLOAD_BYTES });
const formBody = express.raw({ type: [...IMAGE_TYPES, "application/pdf"], limit: env.PHOTO_MAX_UPLOAD_BYTES });

function fail(err: unknown, req: Request, res: Response): void {
  if (err instanceof PhotoError) { res.status(err.status).json({ error: err.code }); return; }
  if (err instanceof UnsupportedImageError) {
    const status = err.message === "PHOTO_BUSY" ? 503
      : ["PHOTO_UNREADABLE", "PHOTO_TOO_SMALL", "PHOTO_TOO_LARGE"].includes(err.message) ? 422 : 415;
    if (status === 503) res.setHeader("Retry-After", "10");
    res.status(status).json({ error: err.message });
    return;
  }
  if (err instanceof PhotoStorageNotConfiguredError) { res.status(503).json({ error: "PHOTO_STORAGE_NOT_CONFIGURED" }); return; }
  if (err instanceof MembershipNotActiveError || err instanceof OrganizationAccessDeniedError) {
    res.status(403).json({ error: "ORGANIZATION_ACCESS_DENIED" }); return;
  }
  if (err instanceof InvalidTenantContextError) { res.status(400).json({ error: "INVALID_ID" }); return; }
  respondInternalError(res, "activity-photos", err, req);
}

function ids(req: Request, res: Response, ...names: string[]): string[] | null {
  const values = names.map((n) => uuid.safeParse(req.params[n]));
  if (values.some((v) => !v.success)) { res.status(400).json({ error: "INVALID_ID" }); return null; }
  return values.map((v) => v.data as string);
}

// Caregiver: attach ONE photo to her activity (raw image body).
router.post("/organizations/:organizationId/care-events/:careEventId/photo", requireAuth, imageBody, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "careEventId"); if (!p) return;
  if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: "PHOTO_UNSUPPORTED_TYPE" }); return; }
  if (req.body.byteLength === 0) { res.status(400).json({ error: "PHOTO_BODY_REQUIRED" }); return; }
  try { res.status(201).json({ photo: await uploadActivityPhoto(req.auth!.userId, p[0], p[1], req.body) }); }
  catch (err) { fail(err, req, res); }
});

// Caregiver (uploader) or agency: the photo attached to an activity, if any.
router.get("/organizations/:organizationId/care-events/:careEventId/photo", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "careEventId"); if (!p) return;
  try { res.status(200).json({ photo: await getActivityPhotoForEvent(req.auth!.userId, p[0], p[1]) }); }
  catch (err) { fail(err, req, res); }
});

// Agency: review queue and decisions.
router.get("/organizations/:organizationId/activity-photos", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId"); if (!p) return;
  const q = listPhotosQuerySchema.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "INVALID_QUERY" }); return; }
  try { res.status(200).json({ photos: await listAgencyPhotos(req.auth!.userId, p[0], q.data) }); }
  catch (err) { fail(err, req, res); }
});

router.get("/organizations/:organizationId/activity-photos/:photoId/history", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "photoId"); if (!p) return;
  try { res.status(200).json({ history: await getAgencyPhotoHistory(req.auth!.userId, p[0], p[1]) }); }
  catch (err) { fail(err, req, res); }
});

router.post("/organizations/:organizationId/activity-photos/:photoId/review", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "photoId"); if (!p) return;
  const body = reviewSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "INVALID_PAYLOAD" }); return; }
  try { res.status(200).json({ photo: await reviewActivityPhoto(req.auth!.userId, p[0], p[1], body.data) }); }
  catch (err) { fail(err, req, res); }
});

// Agency, uploader or authorised relative: the image itself, streamed.
router.get("/organizations/:organizationId/activity-photos/:photoId/image", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "photoId"); if (!p) return;
  try { sendPrivateImage(res, await readActivityPhoto(req.auth!.userId, p[0], p[1]), "actividad.jpg"); }
  catch (err) { fail(err, req, res); }
});

// Agency: photo consents of a resident.
router.get("/organizations/:organizationId/care-recipients/:careRecipientId/photo-consents", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "careRecipientId"); if (!p) return;
  try { res.status(200).json({ consents: await listPhotoConsents(req.auth!.userId, p[0], p[1]) }); }
  catch (err) { fail(err, req, res); }
});

// Body: the signed form (PDF or image). Query: type, signerRole.
router.post("/organizations/:organizationId/care-recipients/:careRecipientId/photo-consents", requireAuth, formBody, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "careRecipientId"); if (!p) return;
  const q = consentQuerySchema.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "INVALID_QUERY" }); return; }
  if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: "PHOTO_UNSUPPORTED_TYPE" }); return; }
  if (req.body.byteLength === 0) { res.status(400).json({ error: "PHOTO_CONSENT_FORM_REQUIRED" }); return; }
  try { res.status(201).json({ consent: await recordPhotoConsent(req.auth!.userId, p[0], p[1], q.data, req.body) }); }
  catch (err) { fail(err, req, res); }
});

router.post("/organizations/:organizationId/photo-consents/:consentId/revoke", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "consentId"); if (!p) return;
  const body = revokeSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "PHOTO_CONSENT_REASON_REQUIRED" }); return; }
  try { res.status(200).json({ consent: await revokePhotoConsent(req.auth!.userId, p[0], p[1], body.data.reason) }); }
  catch (err) { fail(err, req, res); }
});

router.get("/organizations/:organizationId/photo-consents/:consentId/form", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const p = ids(req, res, "organizationId", "consentId"); if (!p) return;
  try {
    const form = await readPhotoConsentForm(req.auth!.userId, p[0], p[1]);
    sendPrivateImage(res, form, form.contentType === "application/pdf" ? "consentimiento.pdf" : "consentimiento.jpg");
  } catch (err) { fail(err, req, res); }
});

export default router;

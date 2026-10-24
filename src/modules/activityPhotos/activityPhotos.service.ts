import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { logInternalError } from "../../observability/internalError.js";
import { sanitizeConsentForm, sanitizeImage } from "./imageSanitizer.js";
import { deletePhotoObject, getPhotoObject, putPhotoObject } from "./photoStorage.js";

/**
 * Activity photos (PR 2). Every decision is taken by the database functions
 * of migrations 115/116, at every request; this service only moves bytes
 * between the request and the private photo bucket. Storage keys and file ids
 * never appear in responses or logs.
 */
export class PhotoError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "PhotoError";
  }
}

const DB_ERRORS: Record<string, number> = {
  FEATURE_NOT_ENABLED: 404,
  PHOTO_FORBIDDEN: 404,
  PHOTO_NOT_FOUND: 404,
  PHOTO_RECIPIENT_NOT_FOUND: 404,
  PHOTO_CONSENT_NOT_FOUND: 404,
  PHOTO_FILE_NOT_FOUND: 404,
  PHOTO_REVIEW_MANAGER_ONLY: 403,
  PHOTO_CONSENT_MANAGER_ONLY: 403,
  PHOTO_CONSENT_REQUIRED: 409,
  PHOTO_ALREADY_ATTACHED: 409,
  PHOTO_FILE_ALREADY_LINKED: 409,
  PHOTO_CONSENT_ALREADY_ACTIVE: 409,
  PHOTO_INVALID_TRANSITION: 409,
  PHOTO_STATUS_CHANGED: 409,
  PHOTO_REASON_REQUIRED: 400,
  PHOTO_CONSENT_REASON_REQUIRED: 400,
  PHOTO_INVALID_DECISION: 400,
  PHOTO_CONSENT_INVALID_TYPE: 400,
  PHOTO_CONSENT_FORM_REQUIRED: 400,
};

/** Maps the database's own error codes (first word of the message) to HTTP. */
function mapDbError(err: unknown): never {
  const message = (err as { message?: unknown })?.message;
  const code = typeof message === "string" ? message.split(" ")[0] : "";
  if (code in DB_ERRORS) {
    // 404 for anything that would reveal whether another resident's or agency's item exists.
    throw new PhotoError(DB_ERRORS[code] === 404 ? "NOT_FOUND" : code, DB_ERRORS[code]);
  }
  throw err;
}

async function inTenant<T>(userId: string, organizationId: string, fn: (trx: never) => Promise<T>): Promise<T> {
  try {
    return await withTenantContext({ userId, organizationId }, (trx) => fn(trx as never));
  } catch (err) {
    if (err instanceof PhotoError) throw err;
    return mapDbError(err);
  }
}

async function removeQuietly(key: string): Promise<void> {
  try { await deletePhotoObject(key); } catch (err) { logInternalError("activity-photo-cleanup", err); }
}

// ------------------------------------------------------------------ caregiver
export async function uploadActivityPhoto(userId: string, organizationId: string, careEventId: string, body: Buffer) {
  // 1. Authorisation BEFORE any byte is processed or stored.
  const recipientId = await inTenant(userId, organizationId, async (trx) =>
    (await sql<{ r: string }>`SELECT app_precheck_activity_photo(${careEventId}::uuid) AS r`.execute(trx)).rows[0].r);
  // 2. Decode and re-encode: EXIF/GPS and every other metadata block removed.
  const image = await sanitizeImage(body);
  // 3. Store under the only key the database will accept for this activity.
  const fileId = randomUUID();
  const key = `activity-photos/${organizationId}/${recipientId}/${fileId}.jpg`;
  await putPhotoObject(key, image.contentType, image.body);
  // 4. Register + attach (re-checks everything, one photo per activity).
  try {
    const photoId = await inTenant(userId, organizationId, async (trx) =>
      (await sql<{ id: string }>`SELECT app_create_activity_photo(${careEventId}::uuid, ${fileId}::uuid, ${key}, ${image.body.byteLength}, ${image.sha256}) AS id`.execute(trx)).rows[0].id);
    return { id: photoId, status: "pending" as const, width: image.width, height: image.height };
  } catch (err) {
    await removeQuietly(key);
    throw err;
  }
}

export async function getActivityPhotoForEvent(userId: string, organizationId: string, careEventId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    // RLS: managers, or the caregiver who uploaded it.
    const r = await sql<{ id: string; share_status: string }>`
      SELECT id, share_status FROM care_event_photos WHERE care_event_id = ${careEventId} AND organization_id = ${organizationId}`.execute(trx);
    if (!r.rows[0]) throw new PhotoError("NOT_FOUND", 404);
    return { id: r.rows[0].id, status: r.rows[0].share_status };
  });
}

// ------------------------------------------------------------------ viewing (agency, uploader, family)
export async function readActivityPhoto(userId: string, organizationId: string, photoId: string) {
  const target = await inTenant(userId, organizationId, async (trx) =>
    (await sql<{ storage_key: string; content_type: string }>`SELECT storage_key, content_type FROM app_activity_photo_for_view(${photoId}::uuid)`.execute(trx)).rows[0]);
  if (!target) throw new PhotoError("NOT_FOUND", 404);
  return { body: await getPhotoObject(target.storage_key), contentType: target.content_type };
}

/**
 * Streams bytes obtained through readActivityPhoto / readPhotoConsentForm
 * (both authorised inside withTenantContext). Private, never cached, sandboxed.
 */
export function sendPrivateImage(res: Response, file: { body: Buffer; contentType: string }, filename: string): void {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Length", String(file.body.byteLength));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.status(200).end(file.body);
}

// ------------------------------------------------------------------ agency review
async function assertManager(trx: never) {
  const r = await sql<{ ok: boolean }>`SELECT app_photo_is_manager() AS ok`.execute(trx);
  if (!r.rows[0]?.ok) throw new PhotoError("PHOTO_REVIEW_MANAGER_ONLY", 403);
}

export const listPhotosQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
  careRecipientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export async function listAgencyPhotos(userId: string, organizationId: string, query: z.infer<typeof listPhotosQuerySchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    await assertManager(trx);
    const conditions = [sql`p.organization_id = ${organizationId}`];
    if (query.status) conditions.push(sql`p.share_status = ${query.status}`);
    if (query.careRecipientId) conditions.push(sql`p.care_recipient_id = ${query.careRecipientId}`);
    const r = await sql<{
      id: string; care_event_id: string; care_recipient_id: string; share_status: string; created_at: string;
      reviewed_at: string | null; review_reason: string | null; occurred_at: string; type_code: string; note_text: string | null;
      first_name: string; last_name: string; uploader_name: string | null;
    }>`
      SELECT p.id, p.care_event_id, p.care_recipient_id, p.share_status, p.created_at, p.reviewed_at, p.review_reason,
             ce.occurred_at, cet.code AS type_code, ce.note_text, cr.first_name, cr.last_name, w.display_name AS uploader_name
      FROM care_event_photos p
      JOIN care_events ce ON ce.id = p.care_event_id
      JOIN care_event_types cet ON cet.id = ce.care_event_type_id
      JOIN care_recipients cr ON cr.id = p.care_recipient_id
      LEFT JOIN organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id
      LEFT JOIN workers w ON w.id = owm.worker_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY p.created_at DESC
      LIMIT ${query.limit ?? 50}`.execute(trx);
    return r.rows.map((row) => ({
      id: row.id, careEventId: row.care_event_id, careRecipientId: row.care_recipient_id,
      careRecipientName: `${row.first_name} ${row.last_name}`.trim(), status: row.share_status,
      uploadedAt: row.created_at, reviewedAt: row.reviewed_at, reviewReason: row.review_reason,
      activity: { type: row.type_code, occurredAt: row.occurred_at, note: row.note_text }, caregiverName: row.uploader_name,
    }));
  });
}

export async function getAgencyPhotoHistory(userId: string, organizationId: string, photoId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    await assertManager(trx);
    const r = await sql<{ action: string; from_status: string | null; to_status: string; reason: string | null; occurred_at: string; actor_email: string | null }>`
      SELECT e.action, e.from_status, e.to_status, e.reason, e.occurred_at, u.email AS actor_email
      FROM care_event_photo_events e LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.photo_id = ${photoId} AND e.organization_id = ${organizationId}
      ORDER BY e.occurred_at, e.id`.execute(trx);
    if (r.rows.length === 0) throw new PhotoError("NOT_FOUND", 404);
    return r.rows.map((e) => ({ action: e.action, from: e.from_status, to: e.to_status, reason: e.reason, at: e.occurred_at, actor: e.actor_email }));
  });
}

export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "WITHDRAW"]),
  /** The status the manager was looking at (optimistic concurrency). */
  expectedStatus: z.enum(["pending", "approved", "rejected", "withdrawn"]),
  reason: z.string().trim().max(300).optional(),
});

export async function reviewActivityPhoto(userId: string, organizationId: string, photoId: string, input: z.infer<typeof reviewSchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ s: string }>`SELECT app_review_activity_photo(${photoId}::uuid, ${input.decision}, ${input.reason ?? null}, ${input.expectedStatus}) AS s`.execute(trx);
    return { id: photoId, status: r.rows[0].s };
  });
}

// ------------------------------------------------------------------ consents (agency)
export const consentQuerySchema = z.object({
  type: z.enum(["PHOTO_CAPTURE", "PHOTO_SHARE_FAMILY"]),
  signerRole: z.enum(["PATIENT", "LEGAL_REPRESENTATIVE"]),
});

export async function listPhotoConsents(userId: string, organizationId: string, careRecipientId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    await assertManager(trx);
    const r = await sql<{ id: string; consent_type: string; version: number; signer_role: string; granted_at: string;
      revoked_at: string | null; revocation_reason: string | null; granted_by: string | null; revoked_by: string | null }>`
      SELECT c.id, c.consent_type, c.version, c.signer_role, c.granted_at, c.revoked_at, c.revocation_reason,
             g.email AS granted_by, rv.email AS revoked_by
      FROM consent_records c
      LEFT JOIN users g ON g.id = c.granted_by_user_id
      LEFT JOIN users rv ON rv.id = c.revoked_by_user_id
      WHERE c.organization_id = ${organizationId} AND c.care_recipient_id = ${careRecipientId}
        AND c.consent_type IN ('PHOTO_CAPTURE', 'PHOTO_SHARE_FAMILY')
      ORDER BY c.consent_type, c.version DESC`.execute(trx);
    return r.rows.map((c) => ({
      id: c.id, type: c.consent_type, version: c.version, signerRole: c.signer_role, grantedAt: c.granted_at, grantedBy: c.granted_by,
      active: c.revoked_at === null, revokedAt: c.revoked_at, revokedBy: c.revoked_by, revocationReason: c.revocation_reason,
    }));
  });
}

export async function recordPhotoConsent(userId: string, organizationId: string, careRecipientId: string,
  input: z.infer<typeof consentQuerySchema>, body: Buffer) {
  await inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ ok: boolean; on: boolean }>`
      SELECT app_photo_is_manager() AS ok, app_org_feature_enabled(${organizationId}::uuid, 'ACTIVITY_PHOTOS') AS on`.execute(trx);
    if (!r.rows[0]?.ok) throw new PhotoError("PHOTO_CONSENT_MANAGER_ONLY", 403);
    if (!r.rows[0]?.on) throw new PhotoError("NOT_FOUND", 404);
  });
  const form = await sanitizeConsentForm(body);
  const fileId = randomUUID();
  const key = `photo-consent-forms/${organizationId}/${careRecipientId}/${fileId}.${form.contentType === "application/pdf" ? "pdf" : "jpg"}`;
  await putPhotoObject(key, form.contentType, form.body);
  try {
    return await inTenant(userId, organizationId, async (trx) => {
      await sql`SELECT app_create_photo_consent_form(${careRecipientId}::uuid, ${fileId}::uuid, ${key}, ${form.contentType}, ${form.body.byteLength}, ${form.sha256})`.execute(trx);
      const c = await sql<{ id: string }>`SELECT app_record_photo_consent(${careRecipientId}::uuid, ${input.type}, ${input.signerRole}, ${fileId}::uuid) AS id`.execute(trx);
      return { id: c.rows[0].id, type: input.type, active: true };
    });
  } catch (err) {
    await removeQuietly(key);
    throw err;
  }
}

export const revokeSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export async function revokePhotoConsent(userId: string, organizationId: string, consentId: string, reason: string) {
  return inTenant(userId, organizationId, async (trx) => {
    await sql`SELECT app_revoke_photo_consent(${consentId}::uuid, ${reason})`.execute(trx);
    return { id: consentId, active: false };
  });
}

export async function readPhotoConsentForm(userId: string, organizationId: string, consentId: string) {
  const target = await inTenant(userId, organizationId, async (trx) =>
    (await sql<{ storage_key: string; content_type: string }>`SELECT storage_key, content_type FROM app_photo_consent_form_for_view(${consentId}::uuid)`.execute(trx)).rows[0]);
  if (!target) throw new PhotoError("NOT_FOUND", 404);
  return { body: await getPhotoObject(target.storage_key), contentType: target.content_type };
}

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { logInternalError } from "../../observability/internalError.js";
import { sanitizeConsentForm, sanitizeImage } from "./imageSanitizer.js";
import { deletePhotoObject, getPhotoObject, isPhotoStorageConfigured, photoObjectExists, putPhotoObject } from "./photoStorage.js";
import { photoStorageIdentityCached } from "./storageIdentity.js";

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
  // v2 (141)
  PHOTO_NOT_SHAREABLE: 409,
  PHOTO_EXPIRED: 409,
  PHOTO_ALREADY_DELETED: 409,
  PHOTO_DELETED_TERMINAL: 409,
  PHOTO_ON_HOLD: 409,
  PHOTO_HOLD_EXISTS: 409,
  PHOTO_HOLD_NOT_ACTIVE: 409,
  PHOTO_HOLD_LIMIT: 409,
  PHOTO_HOLD_REASON_REQUIRED: 400,
  PHOTO_HOLD_REVIEW_INVALID: 400,
  PHOTO_RECEIPT_INVALID: 400,
  PHOTO_RECEIPT_SELF_ONLY: 403,
  // 143: legal hold
  PHOTO_ON_LEGAL_HOLD: 409,
  PHOTO_LEGAL_HOLD_ADMIN_ONLY: 403,
  PHOTO_LEGAL_HOLD_EXISTS: 409,
  PHOTO_LEGAL_HOLD_NOT_ACTIVE: 409,
  PHOTO_LEGAL_HOLD_BASIS_REQUIRED: 400,
  PHOTO_LEGAL_HOLD_REVIEW_INVALID: 400,
  // 145 (M1): what a caregiver hears for ANY hold the agency keeps (never which).
  PHOTO_KEPT_BY_AGENCY: 409,
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
    const created = await inTenant(userId, organizationId, async (trx) => {
      const id = (await sql<{ id: string }>`SELECT app_create_activity_photo(${careEventId}::uuid, ${fileId}::uuid, ${key}, ${image.body.byteLength}, ${image.sha256}) AS id`.execute(trx)).rows[0].id;
      // 145 (L1): read back through the function (RLS would hide a late upload from its own caregiver).
      const row = (await sql<{ share_status: string; retention_until: string }>`SELECT share_status, retention_until FROM app_photo_created_summary(${id}::uuid)`.execute(trx)).rows[0];
      if (!row) throw new PhotoError("NOT_FOUND", 404);
      return { id, status: row.share_status, availableUntil: new Date(row.retention_until).toISOString() };
    });
    // Direct sending (141): "approved" = shared with the authorised family at once;
    // "pending" = kept for the agency only (no sharing consent). Never who or how many.
    return { ...created, sharedWithFamily: created.status === "approved", width: image.width, height: image.height };
  } catch (err) {
    await removeQuietly(key);
    throw err;
  }
}

export async function getActivityPhotoForEvent(userId: string, organizationId: string, careEventId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    // Managers, or the caregiver who uploaded it -- checked here, not only by RLS.
    // The caregiver only inside her window (141): no permanent gallery.
    // D1: she can remove it only inside her window (visit + 1 h) and never while the agency keeps it
    // (a hold in force or a legal hold). Only a yes/no reaches her: never the reason, the basis or which hold.
    // 145 (M4): the hold columns are not readable; a yes/no function answers instead.
    const r = await sql<{ id: string; share_status: string; can_view: boolean; kept: boolean }>`
      SELECT id, share_status, app_photo_uploader_can_view(id) AS can_view, app_photo_kept_by_agency(id) AS kept
      FROM care_event_photos
      WHERE care_event_id = ${careEventId} AND organization_id = ${organizationId} AND deleted_at IS NULL
        AND (app_photo_is_manager() OR app_photo_uploader_can_view(id))`.execute(trx);
    if (!r.rows[0]) throw new PhotoError("NOT_FOUND", 404);
    const row = r.rows[0];
    return { id: row.id, status: row.share_status, sharedWithFamily: row.share_status === "approved",
      canRemove: row.can_view && !row.kept, keptByAgency: row.can_view && row.kept };
  });
}

// ------------------------------------------------------------------ eligibility (caregiver)
/**
 * Only «can this caregiver attach a photo here?». Never the consent's form,
 * signer, dates or type. Not a permission: the upload repeats every check.
 */
export async function getShiftPhotoEligibility(userId: string, organizationId: string, shiftId: string): Promise<{ canAttach: boolean }> {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ ok: boolean }>`SELECT public.app_shift_photo_eligibility(${shiftId}::uuid) AS ok`.execute(trx);
    return { canAttach: r.rows[0]?.ok === true };
  });
}

export async function getActivityPhotoEligibility(userId: string, organizationId: string, careEventId: string): Promise<{ canAttach: boolean }> {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ ok: boolean }>`SELECT public.app_activity_photo_eligibility(${careEventId}::uuid) AS ok`.execute(trx);
    return { canAttach: r.rows[0]?.ok === true };
  });
}

// ------------------------------------------------------------------ viewing (agency, uploader, family)
export async function readActivityPhoto(userId: string, organizationId: string, photoId: string, opts: { legalReview?: boolean } = {}) {
  const target = await inTenant(userId, organizationId, async (trx) => {
    // 145 (§5): switch off → only an explicit legal-review request reaches the database function (which
    // then requires an administrator and a photo under a legal hold, and audits the view). Anything that
    // merely renders the page (stale screens, prefetch) never opens a held image.
    if (!opts.legalReview) {
      const on = (await sql<{ on: boolean }>`SELECT app_org_feature_enabled(${organizationId}::uuid, 'ACTIVITY_PHOTOS') AS on`.execute(trx)).rows[0]?.on === true;
      if (!on) return undefined;
    }
    return (await sql<{ storage_key: string; content_type: string }>`SELECT storage_key, content_type FROM app_activity_photo_for_view(${photoId}::uuid)`.execute(trx)).rows[0];
  });
  if (!target) throw new PhotoError("NOT_FOUND", 404);
  try {
    return { body: await getPhotoObject(target.storage_key), contentType: target.content_type };
  } catch (err) {
    // 145: a file missing from the bucket (a reconciliation finding, never tombstoned while unconfirmed)
    // is a 404, not a 500. Logged as a class name only (never the key).
    const name = (err as Error)?.name;
    if (name === "NoSuchKey" || (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
      console.error("PHOTO_FILE_MISSING_ON_READ", { name });
      throw new PhotoError("NOT_FOUND", 404);
    }
    throw err;
  }
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
  status: z.enum(["pending", "approved", "rejected", "withdrawn", "deleted"]).optional(),
  careRecipientId: z.string().uuid().optional(),
  /** 144 (D2): the photos the daily notice points to — under a legal hold whose review date has passed (any status). 145: "active" = every legal hold. */
  legalReview: z.enum(["overdue", "active"]).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * 145: what the photo screens may show this person in this agency.
 * "full" (switch on, administration or supervision), "legal-review" (switch off,
 * ORGANIZATION_ADMIN, some photo under a legal hold: review / release only) or "off".
 */
export async function getAgencyPhotoMode(userId: string, organizationId: string): Promise<{ mode: "full" | "legal-review" | "off" }> {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ m: "full" | "legal-review" | "off" }>`SELECT app_photo_agency_mode() AS m`.execute(trx);
    return { mode: r.rows[0]?.m ?? "off" };
  });
}

async function agencyMode(trx: never, organizationId: string): Promise<{ mode: string; admin: boolean; featureOn: boolean }> {
  const r = await sql<{ m: string; a: boolean; f: boolean }>`
    SELECT app_photo_agency_mode() AS m, app_is_org_admin() AS a, app_org_feature_enabled(${organizationId}::uuid, 'ACTIVITY_PHOTOS') AS f`.execute(trx);
  return { mode: r.rows[0]?.m ?? "off", admin: r.rows[0]?.a === true, featureOn: r.rows[0]?.f === true };
}

export async function listAgencyPhotos(userId: string, organizationId: string, query: z.infer<typeof listPhotosQuerySchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const { mode, admin, featureOn } = await agencyMode(trx, organizationId);
    if (mode === "off") throw featureOn ? new PhotoError("PHOTO_REVIEW_MANAGER_ONLY", 403) : new PhotoError("FEATURE_NOT_ENABLED", 404);
    const conditions = [sql`p.organization_id = ${organizationId}`];
    // Legal-review mode (switch off): only photos under a legal hold, never deleted ones.
    if (mode === "legal-review") conditions.push(sql`p.deleted_at IS NULL AND p.legal_hold_placed_at IS NOT NULL`);
    if (query.status) conditions.push(sql`p.share_status = ${query.status}`);
    if (query.careRecipientId) conditions.push(sql`p.care_recipient_id = ${query.careRecipientId}`);
    if (query.legalReview === "overdue") {
      conditions.push(sql`p.deleted_at IS NULL AND p.legal_hold_placed_at IS NOT NULL AND p.legal_hold_review_at <= now()`);
    } else if (query.legalReview === "active") {
      conditions.push(sql`p.deleted_at IS NULL AND p.legal_hold_placed_at IS NOT NULL`);
    }
    const r = await sql<{
      id: string; care_event_id: string; care_recipient_id: string; share_status: string; created_at: string; shared_at: string | null;
      reviewed_at: string | null; occurred_at: string; type_code: string; note_text: string | null;
      first_name: string; last_name: string; uploader_name: string | null; retention_until: string; deleted_at: string | null;
      deletion_kind: string | null; purge_verified_at: string | null;
      hold_review_at: string | null; hold_by: string | null; hold_actions: number; hold_on: boolean; hold_active: boolean; expired: boolean;
      legal_on: boolean; legal_hold_review_at: string | null; legal_hold_placed_at: string | null;
    }>`
      SELECT p.id, p.care_event_id, p.care_recipient_id, p.share_status, p.created_at, p.shared_at, p.reviewed_at,
             ce.occurred_at, cet.code AS type_code, ce.note_text, cr.first_name, cr.last_name, w.display_name AS uploader_name,
             p.retention_until, p.deleted_at, p.deletion_kind, p.purge_verified_at,
             p.hold_review_at, hu.email AS hold_by, p.hold_actions, (p.hold_placed_at IS NOT NULL) AS hold_on,
             (p.hold_placed_at IS NOT NULL AND p.hold_review_at > now()) AS hold_active, (now() >= p.retention_until) AS expired,
             (p.legal_hold_placed_at IS NOT NULL) AS legal_on, p.legal_hold_review_at, p.legal_hold_placed_at
      FROM care_event_photos p
      JOIN care_events ce ON ce.id = p.care_event_id
      JOIN care_event_types cet ON cet.id = ce.care_event_type_id
      JOIN care_recipients cr ON cr.id = p.care_recipient_id
      LEFT JOIN organization_worker_memberships owm ON owm.id = ce.organization_worker_membership_id
      LEFT JOIN workers w ON w.id = owm.worker_id
      LEFT JOIN users hu ON hu.id = p.hold_by_user_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY p.created_at DESC
      LIMIT ${query.limit ?? 50}`.execute(trx);
    // 145 (M4 / §6): free text through the function; legal basis, reference and author only for administrators.
    const ids = r.rows.map((row) => row.id);
    const conf = new Map<string, { review_reason: string | null; deletion_reason: string | null; hold_reason: string | null;
      legal_hold_basis: string | null; legal_hold_reference: string | null; legal_hold_by: string | null }>();
    if (ids.length > 0) {
      const c = await sql<{ photo_id: string; review_reason: string | null; deletion_reason: string | null; hold_reason: string | null;
        legal_hold_basis: string | null; legal_hold_reference: string | null; legal_hold_by: string | null }>`
        SELECT * FROM app_photo_confidential(${ids}::uuid[])`.execute(trx);
      for (const row of c.rows) conf.set(row.photo_id, row);
    }
    return r.rows.map((row) => {
      const c = conf.get(row.id);
      return {
        id: row.id, careEventId: row.care_event_id, careRecipientId: row.care_recipient_id,
        careRecipientName: `${row.first_name} ${row.last_name}`.trim(), status: row.share_status,
        uploadedAt: row.created_at, sharedAt: row.shared_at, reviewedAt: row.reviewed_at, reviewReason: c?.review_reason ?? null,
        activity: { type: row.type_code, occurredAt: row.occurred_at, note: row.note_text }, caregiverName: row.uploader_name,
        // Provisional retention (141): after this nobody sees it (managers only under an exceptional hold).
        availableUntil: row.retention_until, expired: row.expired,
        // Visible to the agency only while not expired, or under a hold in force.
        viewable: row.deleted_at === null && (!row.expired || row.hold_active || row.legal_on),
        deletion: row.deleted_at ? { at: row.deleted_at, kind: row.deletion_kind, reason: c?.deletion_reason ?? null, purgeVerified: row.purge_verified_at !== null } : null,
        // 143: never deleted while in force, no time limit; an overdue review is flagged, not released.
        // 145 (§6): supervision sees THAT it exists and its dates; basis, reference and author only the administration.
        legalHold: row.legal_on ? {
          placedAt: row.legal_hold_placed_at, reviewAt: row.legal_hold_review_at,
          reviewOverdue: row.legal_hold_review_at !== null && Date.parse(row.legal_hold_review_at) <= Date.now(),
          ...(admin ? { basis: c?.legal_hold_basis ?? null, reference: c?.legal_hold_reference ?? null, by: c?.legal_hold_by ?? null } : {}),
        } : null,
        hold: row.hold_on ? { active: row.hold_active, reason: c?.hold_reason ?? null, reviewAt: row.hold_review_at, by: row.hold_by, actionsUsed: row.hold_actions, actionsMax: 3 } : null,
      };
    });
  });
}

export async function getAgencyPhotoHistory(userId: string, organizationId: string, photoId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    // 145: through the function (manager only; legal-hold text only for administrators; legal-review mode: held photos only).
    const r = await sql<{ action: string; from_status: string | null; to_status: string; reason: string | null; occurred_at: string; actor_email: string | null }>`
      SELECT h.action, h.from_status, h.to_status, h.reason, h.occurred_at, u.email AS actor_email
      FROM app_photo_history(${photoId}::uuid) h LEFT JOIN users u ON u.id = h.actor_user_id
      -- UPLOADED and SHARED share the timestamp (same transaction): the upload goes first.
      ORDER BY h.occurred_at, (h.action <> 'UPLOADED'), h.event_id`.execute(trx);
    if (r.rows.length === 0) throw new PhotoError("NOT_FOUND", 404);
    return r.rows.map((e) => ({ action: e.action, from: e.from_status, to: e.to_status, reason: e.reason, at: e.occurred_at, actor: e.actor_email }));
  });
}

export const reviewSchema = z.object({
  /** 141: no manual approval. WITHDRAW hides it from the family; APPROVE shows a withdrawn photo again. REJECT is refused. */
  decision: z.enum(["APPROVE", "REJECT", "WITHDRAW"]),
  /** The status the manager was looking at (optimistic concurrency). */
  expectedStatus: z.enum(["pending", "approved", "rejected", "withdrawn", "deleted"]),
  reason: z.string().trim().max(300).optional(),
});

export async function reviewActivityPhoto(userId: string, organizationId: string, photoId: string, input: z.infer<typeof reviewSchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ s: string }>`SELECT app_review_activity_photo(${photoId}::uuid, ${input.decision}, ${input.reason ?? null}, ${input.expectedStatus}) AS s`.execute(trx);
    return { id: photoId, status: r.rows[0].s };
  });
}

// ------------------------------------------------------------------ removal (agency: reason; caregiver: her window)
export const deleteSchema = z.object({ reason: z.string().trim().max(300).optional() });

/**
 * Removal (141): the database marks the tombstone and queues the file in one
 * transaction (from then on nobody receives the image). The object is then
 * removed and its absence verified (HeadObject 404); only then are the key,
 * size and checksum dropped. If the storage fails, the queue keeps it for V2's
 * retries: access is already cut.
 */
export async function deleteActivityPhoto(userId: string, organizationId: string, photoId: string, reason?: string) {
  const kind = await inTenant(userId, organizationId, async (trx) =>
    (await sql<{ k: string }>`SELECT app_delete_activity_photo(${photoId}::uuid, ${reason ?? null}) AS k`.execute(trx)).rows[0].k);
  const purged = await purgeNow(userId, organizationId, photoId);
  return { id: photoId, status: "deleted" as const, kind, purged };
}

async function purgeNow(userId: string, organizationId: string, photoId: string): Promise<boolean> {
  if (!isPhotoStorageConfigured()) return false;
  // 145 (H1): never delete in a bucket that has not proved its identity. Access is
  // already cut (tombstone); the key stays queued for the job.
  if ((await photoStorageIdentityCached()) !== "OK") return false;
  const key = await inTenant(userId, organizationId, async (trx) =>
    (await sql<{ k: string | null }>`SELECT app_photo_purge_claim(${photoId}::uuid) AS k`.execute(trx)).rows[0].k);
  if (!key) return false;
  let verified = false; let error: string | null = null;
  try {
    await deletePhotoObject(key);
    verified = !(await photoObjectExists(key));
    if (!verified) error = "STILL_PRESENT";
  } catch (err) {
    error = (err as Error)?.name ?? "STORAGE_ERROR";
    logInternalError("activity-photo-purge", err);
  }
  await inTenant(userId, organizationId, async (trx) => {
    await sql`SELECT app_photo_purge_result(${photoId}::uuid, ${verified}, ${error})`.execute(trx);
  });
  return verified;
}

// ------------------------------------------------------------------ exceptional holds (agency managers)
export const holdSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("PLACE"), reason: z.string().trim().min(10).max(300), reviewAt: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal("RENEW"), reason: z.string().trim().min(10).max(300), reviewAt: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal("RELEASE"), reason: z.string().trim().min(10).max(300) }),
]);

export async function holdActivityPhoto(userId: string, organizationId: string, photoId: string, input: z.infer<typeof holdSchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const reviewAt = "reviewAt" in input ? input.reviewAt : null;
    const r = await sql<{ at: string | null }>`SELECT app_photo_hold_write(${photoId}::uuid, ${input.action}, ${input.reason}, ${reviewAt}::timestamptz) AS at`.execute(trx);
    return { id: photoId, holdActive: input.action !== "RELEASE", reviewAt: r.rows[0].at };
  });
}

// ------------------------------------------------------------------ legal hold (143, administrators only)
export const legalHoldSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("PLACE"), basis: z.string().trim().min(10).max(300), reference: z.string().trim().max(120).optional(), reviewAt: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal("REVIEW"), basis: z.string().trim().min(10).max(300), reference: z.string().trim().max(120).optional(), reviewAt: z.string().datetime({ offset: true }) }),
  z.object({ action: z.literal("RELEASE"), basis: z.string().trim().min(10).max(300) }),
]);

export async function legalHoldActivityPhoto(userId: string, organizationId: string, photoId: string, input: z.infer<typeof legalHoldSchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const reviewAt = "reviewAt" in input ? input.reviewAt : null;
    const reference = "reference" in input ? input.reference ?? null : null;
    const r = await sql<{ at: string | null }>`SELECT app_photo_legal_hold_write(${photoId}::uuid, ${input.action}, ${input.basis}, ${reference}, ${reviewAt}::timestamptz) AS at`.execute(trx);
    return { id: photoId, legalHoldActive: input.action !== "RELEASE", reviewAt: r.rows[0].at };
  });
}

// ------------------------------------------------------------------ the relative's own authorization (141)
/** Version of the authorization text the relative accepted (the frontend sends the one it showed). */
export const receiptSchema = z.object({
  decision: z.enum(["accepted", "declined"]),
  textVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
});

export async function getFamilyPhotoReceipt(userId: string, organizationId: string, careRecipientId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ decision: string; decided_at: string | null; text_version: string | null }>`
      SELECT decision, decided_at, text_version FROM app_family_photo_receipt(${careRecipientId}::uuid)`.execute(trx);
    if (!r.rows[0]) throw new PhotoError("NOT_FOUND", 404);
    return { decision: r.rows[0].decision, decidedAt: r.rows[0].decided_at, textVersion: r.rows[0].text_version };
  });
}

export async function setFamilyPhotoReceipt(userId: string, organizationId: string, careRecipientId: string, input: z.infer<typeof receiptSchema>) {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ at: string }>`SELECT app_set_family_photo_receipt(${careRecipientId}::uuid, ${input.decision}, ${input.textVersion}) AS at`.execute(trx);
    // A2: only photos sent from this moment on (never earlier ones).
    return { decision: input.decision, decidedAt: r.rows[0].at, textVersion: input.textVersion };
  });
}

export async function listPhotoRecipients(userId: string, organizationId: string, careRecipientId: string) {
  return inTenant(userId, organizationId, async (trx) => {
    const r = await sql<{ relationship_id: string; email: string; relationship_type: string; photo_receipt: string; photo_receipt_at: string | null; can_view_photos: boolean }>`
      SELECT * FROM app_photo_recipients(${careRecipientId}::uuid)`.execute(trx);
    return r.rows.map((x) => ({
      relationshipId: x.relationship_id, email: x.email, relationshipType: x.relationship_type,
      receipt: x.photo_receipt, decidedAt: x.photo_receipt_at, allowedByAgency: x.can_view_photos,
      receives: x.photo_receipt === "accepted" && x.can_view_photos,
    }));
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

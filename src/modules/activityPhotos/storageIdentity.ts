import { randomUUID } from "node:crypto";
import { pool } from "../../config/db.js";
import { classifyStorageError, freshBindAllowed, type StorageCheck } from "./storageIdentityRules.js";
import { checkPhotoStorage, getPhotoText, isPhotoStorageConfigured, listPhotoObjects, putPhotoText } from "./photoStorage.js";

/**
 * Migration 145 (H1): before the photo job (or a removal) touches the bucket,
 * the storage must prove it is the bucket the database belongs to.
 *
 * A random marker is bound in the database and written to
 * `_etnara/storage-identity.json` once, only on a fresh deployment (no live
 * photo, no queued removal, no unpurged file, no marker and no photo object in
 * the bucket), so a wrong (existing) bucket can never be bound over real data. Afterwards every
 * check reads the marker back: a missing marker (empty / new / wrong bucket) or
 * a different one stops every deletion and reconciliation. Binding an existing
 * deployment with photos is an operator decision (ops/145 procedure).
 *
 * Results are fixed codes: never keys, bucket names, URLs or credentials.
 */
export { classifyStorageError, freshBindAllowed, type StorageCheck } from "./storageIdentityRules.js";
export const STORAGE_IDENTITY_KEY = "_etnara/storage-identity.json";

type Q = { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };


function parseMarker(text: string | null): string | null {
  if (text === null) return null;
  try {
    const v = (JSON.parse(text) as { marker?: unknown })?.marker;
    return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : "";
  } catch { return ""; }
}


/**
 * Runs on a connection WITHOUT a tenant context (the 145 functions refuse one).
 * May bind the marker when the database has no live photo and none is bound.
 */
export async function verifyPhotoStorageIdentity(db: Q, bindAs: "job" | "startup"): Promise<StorageCheck> {
  if (!isPhotoStorageConfigured()) return "STORAGE_NOT_CONFIGURED";
  try { await checkPhotoStorage(); } catch (err) { return classifyStorageError(err); }
  let state: { marker: string | null; live_photos: number } | undefined;
  try {
    state = (await db.query<{ marker: string | null; live_photos: number }>(`SELECT * FROM app_photo_storage_identity()`)).rows[0];
  } catch { return "STORAGE_IDENTITY_UNKNOWN"; }
  let stored: string | null;
  try { stored = parseMarker(await getPhotoText(STORAGE_IDENTITY_KEY)); } catch (err) { return classifyStorageError(err); }
  if (!state?.marker) {
    // Fresh deployment only. Never adopt a marker that is already in the bucket (it may be another
    // deployment's, e.g. staging pointed at production) and never bind a bucket that already holds
    // photo objects: both are operator decisions (ops/145_photo_storage_identity.md).
    let bucketHasPhotos: boolean;
    try { bucketHasPhotos = (await listPhotoObjects("activity-photos/")).items.length > 0; }
    catch (err) { return classifyStorageError(err); }
    if (!freshBindAllowed({ livePhotos: state?.live_photos ?? null, bucketMarker: stored, bucketHasPhotos })) return "STORAGE_IDENTITY_UNBOUND";
    // The database decides first (one winner across replicas, and it re-checks the queue and the
    // files); only the winner writes its marker to the bucket.
    const marker = randomUUID();
    try {
      const bound = (await db.query<{ ok: boolean }>(`SELECT app_photo_bind_storage_identity($1::uuid, $2) AS ok`, [marker, bindAs])).rows[0]?.ok;
      if (!bound) return "STORAGE_IDENTITY_UNBOUND";
    } catch { return "STORAGE_IDENTITY_UNKNOWN"; }
    try {
      await putPhotoText(STORAGE_IDENTITY_KEY, JSON.stringify({ marker, note: "ETNARA activity photos storage identity. Do not delete." }));
      return parseMarker(await getPhotoText(STORAGE_IDENTITY_KEY)) === marker ? "OK" : "STORAGE_IDENTITY_MISMATCH";
    } catch (err) { return classifyStorageError(err); }
  }
  if (stored === null) return "STORAGE_IDENTITY_MISSING";
  return stored === state.marker.toLowerCase() ? "OK" : "STORAGE_IDENTITY_MISMATCH";
}

let cache: { at: number; result: StorageCheck } | null = null;
const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

/** For request paths (a removal): a fresh connection without tenant context, cached briefly. */
export async function photoStorageIdentityCached(): Promise<StorageCheck> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.result === "OK" ? OK_TTL_MS : FAIL_TTL_MS)) return cache.result;
  const client = await pool.connect();
  let result: StorageCheck;
  try { result = await verifyPhotoStorageIdentity(client as unknown as Q, "startup"); }
  catch { result = "STORAGE_IDENTITY_UNKNOWN"; }
  finally { client.release(); }
  cache = { at: now, result };
  return result;
}

/** Test hook. */
export function resetPhotoStorageIdentityCacheForTests(): void { cache = null; }

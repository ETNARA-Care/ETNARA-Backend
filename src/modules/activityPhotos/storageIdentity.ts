import { randomUUID } from "node:crypto";
import { pool } from "../../config/db.js";
import { checkPhotoStorage, getPhotoText, isPhotoStorageConfigured, putPhotoText } from "./photoStorage.js";

/**
 * Migration 145 (H1): before the photo job (or a removal) touches the bucket,
 * the storage must prove it is the bucket the database belongs to.
 *
 * A random marker is written once to `_etnara/storage-identity.json` and bound
 * in the database, and only while the database has NO live photo, so a wrong
 * (existing) bucket can never be bound over real photos. Afterwards every
 * check reads the marker back: a missing marker (empty / new / wrong bucket) or
 * a different one stops every deletion and reconciliation. Binding an existing
 * deployment with photos is an operator decision (ops/145 procedure).
 *
 * Results are fixed codes: never keys, bucket names, URLs or credentials.
 */
export const STORAGE_IDENTITY_KEY = "_etnara/storage-identity.json";

export type StorageCheck =
  | "OK" | "STORAGE_NOT_CONFIGURED" | "STORAGE_ACCESS_DENIED" | "STORAGE_BUCKET_NOT_FOUND" | "STORAGE_UNREACHABLE"
  | "STORAGE_IDENTITY_UNBOUND" | "STORAGE_IDENTITY_MISSING" | "STORAGE_IDENTITY_MISMATCH" | "STORAGE_IDENTITY_UNKNOWN";

type Q = { query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export function classifyStorageError(err: unknown): StorageCheck {
  const e = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? e?.Code ?? "";
  const status = e?.$metadata?.httpStatusCode;
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "Forbidden", "InvalidToken", "ExpiredToken"].includes(name) || status === 403 || status === 401) {
    return "STORAGE_ACCESS_DENIED";
  }
  if (name === "NoSuchBucket" || name === "NotFound" || status === 404) return "STORAGE_BUCKET_NOT_FOUND";
  return "STORAGE_UNREACHABLE";
}

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
    if ((state?.live_photos ?? 1) > 0) return "STORAGE_IDENTITY_UNBOUND";
    // Fresh deployment: no live photo can be lost. Reuse a marker already in the bucket, or write one.
    const marker = stored || randomUUID();
    try {
      if (!stored) {
        await putPhotoText(STORAGE_IDENTITY_KEY, JSON.stringify({ marker, note: "ETNARA activity photos storage identity. Do not delete." }));
        if (parseMarker(await getPhotoText(STORAGE_IDENTITY_KEY)) !== marker) return "STORAGE_IDENTITY_MISMATCH";
      }
    } catch (err) { return classifyStorageError(err); }
    try {
      const bound = (await db.query<{ ok: boolean }>(`SELECT app_photo_bind_storage_identity($1::uuid, $2) AS ok`, [marker, bindAs])).rows[0]?.ok;
      if (!bound) return verifyPhotoStorageIdentity(db, bindAs); // raced with another replica, or a photo arrived: re-check
    } catch { return "STORAGE_IDENTITY_UNKNOWN"; }
    return "OK";
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

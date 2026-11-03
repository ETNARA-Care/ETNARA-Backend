/** 145 (H1): pure rules of the storage identity check (no I/O; unit-tested). */
export type StorageCheck =
  | "OK" | "STORAGE_NOT_CONFIGURED" | "STORAGE_ACCESS_DENIED" | "STORAGE_BUCKET_NOT_FOUND" | "STORAGE_UNREACHABLE"
  | "STORAGE_IDENTITY_UNBOUND" | "STORAGE_IDENTITY_MISSING" | "STORAGE_IDENTITY_MISMATCH" | "STORAGE_IDENTITY_UNKNOWN";

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

/** Automatic binding only on a fresh deployment: no live photo, no marker and no photo object in the bucket. */
export function freshBindAllowed(x: { livePhotos: number | null; bucketMarker: string | null; bucketHasPhotos: boolean }): boolean {
  return x.livePhotos === 0 && x.bucketMarker === null && !x.bucketHasPhotos;
}

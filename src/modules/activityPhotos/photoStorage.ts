import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Activity photos live in their OWN private bucket (PHOTO_STORAGE_*). There is
 * deliberately no fallback to the documents bucket (STORAGE_*) and no
 * presigned URL: the API streams the bytes after the database authorises each
 * request, so no link to the bucket ever reaches a browser.
 */
export class PhotoStorageNotConfiguredError extends Error {
  constructor() {
    super("PHOTO_STORAGE_NOT_CONFIGURED");
    this.name = "PhotoStorageNotConfiguredError";
  }
}

let cached: { s3: S3Client; bucket: string } | null = null;

function photoClient() {
  const values = [env.PHOTO_STORAGE_ENDPOINT, env.PHOTO_STORAGE_REGION, env.PHOTO_STORAGE_BUCKET,
    env.PHOTO_STORAGE_ACCESS_KEY_ID, env.PHOTO_STORAGE_SECRET_ACCESS_KEY];
  if (!values.every(Boolean)) throw new PhotoStorageNotConfiguredError();
  if (env.STORAGE_BUCKET && env.PHOTO_STORAGE_BUCKET === env.STORAGE_BUCKET && env.PHOTO_STORAGE_ENDPOINT === env.STORAGE_ENDPOINT) {
    // Decision 4: photos never share the documents bucket.
    throw new PhotoStorageNotConfiguredError();
  }
  if (!cached) {
    cached = {
      bucket: env.PHOTO_STORAGE_BUCKET!,
      s3: new S3Client({
        endpoint: env.PHOTO_STORAGE_ENDPOINT,
        region: env.PHOTO_STORAGE_REGION,
        forcePathStyle: env.PHOTO_STORAGE_FORCE_PATH_STYLE,
        credentials: { accessKeyId: env.PHOTO_STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.PHOTO_STORAGE_SECRET_ACCESS_KEY! },
      }),
    };
  }
  return cached;
}

export function isPhotoStorageConfigured(): boolean {
  try { photoClient(); return true; } catch { return false; }
}

/** Reachability check for operations (no object is listed or returned). */
export async function checkPhotoStorage(): Promise<void> {
  const { s3, bucket } = photoClient();
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
}

export async function putPhotoObject(key: string, contentType: string, body: Buffer): Promise<void> {
  const { s3, bucket } = photoClient();
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength,
    CacheControl: "private, no-store",
  }));
}

export async function getPhotoObject(key: string): Promise<Buffer> {
  const { s3, bucket } = photoClient();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error("PHOTO_OBJECT_EMPTY");
  return Buffer.from(bytes);
}

export async function deletePhotoObject(key: string): Promise<void> {
  const { s3, bucket } = photoClient();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export interface PhotoStorageSelfCheck {
  configured: boolean;
  separateFromDocuments: boolean;
  authenticated: boolean;
  roundTrip: boolean;
  anonymousReadDenied: boolean;
  anonymousListDenied: boolean;
  cleanedUp: boolean;
  error?: string;
}

/**
 * Deployment self-check, run INSIDE the backend (credentials never leave it).
 * Writes one tiny synthetic text object under `_selfcheck/`, reads it back
 * with the credentials, tries to read it and to list the bucket WITHOUT
 * credentials (both must be refused), then deletes it. The result contains
 * only yes/no values and an error class name: never keys, URLs or names.
 */
export async function photoStorageSelfCheck(fetchImpl: typeof fetch = fetch): Promise<PhotoStorageSelfCheck> {
  const result: PhotoStorageSelfCheck = {
    configured: false, separateFromDocuments: false, authenticated: false, roundTrip: false,
    anonymousReadDenied: false, anonymousListDenied: false, cleanedUp: false,
  };
  let client: ReturnType<typeof photoClient>;
  try { client = photoClient(); } catch { return result; }
  result.configured = true;
  result.separateFromDocuments = env.PHOTO_STORAGE_BUCKET !== env.STORAGE_BUCKET;
  const key = `_selfcheck/${crypto.randomUUID()}.txt`;
  const probe = Buffer.from("etnara photo storage self-check (synthetic)");
  let written = false;
  try {
    await client.s3.send(new HeadBucketCommand({ Bucket: client.bucket }));
    result.authenticated = true;
    await client.s3.send(new PutObjectCommand({ Bucket: client.bucket, Key: key, Body: probe, ContentType: "text/plain", CacheControl: "private, no-store" }));
    written = true;
    const back = await client.s3.send(new GetObjectCommand({ Bucket: client.bucket, Key: key }));
    result.roundTrip = Buffer.from((await back.Body?.transformToByteArray()) ?? []).equals(probe);
    const endpoint = new URL(env.PHOTO_STORAGE_ENDPOINT!);
    const bucketUrl = env.PHOTO_STORAGE_FORCE_PATH_STYLE
      ? `${endpoint.origin}/${client.bucket}/`
      : `${endpoint.protocol}//${client.bucket}.${endpoint.host}/`;
    const refused = async (url: string) => {
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      await res.arrayBuffer().catch(() => undefined);
      return res.status === 401 || res.status === 403;
    };
    result.anonymousReadDenied = await refused(bucketUrl + key);
    result.anonymousListDenied = await refused(bucketUrl);
  } catch (err) {
    result.error = (err as Error)?.name ?? "Error";
  } finally {
    if (written) {
      try { await client.s3.send(new DeleteObjectCommand({ Bucket: client.bucket, Key: key })); result.cleanedUp = true; } catch { /* reported as cleanedUp=false */ }
    } else {
      result.cleanedUp = true;
    }
  }
  return result;
}

export function photoStorageSelfCheckPassed(r: PhotoStorageSelfCheck): boolean {
  return r.configured && r.separateFromDocuments && r.authenticated && r.roundTrip && r.anonymousReadDenied && r.anonymousListDenied && r.cleanedUp;
}

/** Test hook: the verifier points the module at its own local bucket. */
export function resetPhotoStorageClientForTests(): void { cached = null; }

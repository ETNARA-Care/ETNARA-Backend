import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Facturación F2.3 (A6): invoice PDFs and agency logos live in their OWN
 * private bucket (BILLING_STORAGE_*). There is no fallback to the documents
 * or photos buckets, no public URL and no presigned URL: the API checks
 * billing.view in the database and streams the bytes, verifying the SHA-256
 * stored in PostgreSQL. The application never deletes an invoice object.
 */
export class BillingStorageNotConfiguredError extends Error {
  constructor() {
    super("BILLING_STORAGE_NOT_CONFIGURED");
    this.name = "BillingStorageNotConfiguredError";
  }
}

let cached: { s3: S3Client; bucket: string } | null = null;
function client() {
  const values = [env.BILLING_STORAGE_ENDPOINT, env.BILLING_STORAGE_REGION, env.BILLING_STORAGE_BUCKET,
    env.BILLING_STORAGE_ACCESS_KEY_ID, env.BILLING_STORAGE_SECRET_ACCESS_KEY];
  if (!values.every(Boolean)) throw new BillingStorageNotConfiguredError();
  const sameAs = (endpoint?: string, bucket?: string) => Boolean(bucket) && bucket === env.BILLING_STORAGE_BUCKET && endpoint === env.BILLING_STORAGE_ENDPOINT;
  if (sameAs(env.STORAGE_ENDPOINT, env.STORAGE_BUCKET) || sameAs(env.PHOTO_STORAGE_ENDPOINT, env.PHOTO_STORAGE_BUCKET)) {
    throw new BillingStorageNotConfiguredError(); // never share a bucket with documents or photos
  }
  if (!cached) {
    cached = {
      bucket: env.BILLING_STORAGE_BUCKET!,
      s3: new S3Client({
        endpoint: env.BILLING_STORAGE_ENDPOINT,
        region: env.BILLING_STORAGE_REGION,
        forcePathStyle: env.BILLING_STORAGE_FORCE_PATH_STYLE,
        credentials: { accessKeyId: env.BILLING_STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.BILLING_STORAGE_SECRET_ACCESS_KEY! },
      }),
    };
  }
  return cached;
}

export function isBillingStorageConfigured(): boolean {
  try { client(); return true; } catch { return false; }
}

export const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");

/** Write once: the key always contains the content hash, so an object is never overwritten. */
export async function putBillingObject(key: string, contentType: string, body: Buffer): Promise<void> {
  const { s3, bucket } = client();
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength,
    CacheControl: "private, no-store",
  }));
}

export class BillingObjectIntegrityError extends Error {
  constructor() { super("BILLING_DOCUMENT_INTEGRITY"); this.name = "BillingObjectIntegrityError"; }
}

/** Reads an object and refuses it if its SHA-256 does not match the one recorded at issue. */
export async function getBillingObjectVerified(key: string, expectedSha256: string): Promise<Buffer> {
  const { s3, bucket } = client();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new BillingObjectIntegrityError();
  const body = Buffer.from(bytes);
  if (sha256(body) !== expectedSha256) throw new BillingObjectIntegrityError();
  return body;
}

export async function checkBillingStorage(): Promise<void> {
  const { s3, bucket } = client();
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
}

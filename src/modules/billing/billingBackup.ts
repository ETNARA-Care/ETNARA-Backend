import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

/**
 * Facturación F2.3 — independent daily copy of the billing documents (approved as a goal 25-oct;
 * NOT configured in production until Rafa authorises it).
 *
 * - Source of truth: PostgreSQL (invoice_documents and the logos referenced by issued invoices,
 *   each with its SHA-256). Only keys and hashes are read; never names, amounts or content.
 * - Every object is read from the billing bucket and accepted only if its SHA-256 matches; it is
 *   written to the backup bucket under `billing/<same key>` with its hash as metadata and read back.
 * - Append-only: the copy never deletes and never overwrites. A backup object with another hash is
 *   reported (alert), not replaced. A source object that is missing or altered is reported.
 * - A manifest per day (`billing/manifests/YYYY-MM-DD.json`) lists keys and hashes only.
 * - The backup bucket's credentials live ONLY in the copy job, never in the backend: a compromised
 *   backend cannot erase the copies.
 */
export interface BucketRef { s3: S3Client; bucket: string }
export interface ExpectedObject { key: string; sha256: string }
export interface CopyReport {
  copied: number; alreadyPresent: number;
  missingOrAlteredInSource: string[]; conflictingCopy: string[]; manifestKey: string | null;
}

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const BACKUP_PREFIX = "billing/";

export function bucketFromEnv(prefix: "BILLING_STORAGE" | "BILLING_BACKUP_STORAGE", source: NodeJS.ProcessEnv = process.env): BucketRef | null {
  const v = (k: string) => source[`${prefix}_${k}`];
  if (!v("ENDPOINT") || !v("REGION") || !v("BUCKET") || !v("ACCESS_KEY_ID") || !v("SECRET_ACCESS_KEY")) return null;
  return {
    bucket: v("BUCKET")!,
    s3: new S3Client({ endpoint: v("ENDPOINT"), region: v("REGION"), forcePathStyle: v("FORCE_PATH_STYLE") === "true",
      credentials: { accessKeyId: v("ACCESS_KEY_ID")!, secretAccessKey: v("SECRET_ACCESS_KEY")! } }),
  };
}

async function readVerified(ref: BucketRef, key: string, expected: string): Promise<Buffer | null> {
  try {
    const r = await ref.s3.send(new GetObjectCommand({ Bucket: ref.bucket, Key: key }));
    const bytes = await r.Body?.transformToByteArray();
    if (!bytes) return null;
    const body = Buffer.from(bytes);
    return hash(body) === expected ? body : null;
  } catch { return null; }
}

async function copyHash(ref: BucketRef, key: string): Promise<string | null | undefined> {
  try {
    const h = await ref.s3.send(new HeadObjectCommand({ Bucket: ref.bucket, Key: key }));
    return h.Metadata?.sha256 ?? null; // present (null = present without our metadata)
  } catch { return undefined; } // absent
}

export async function dailyCopy(source: BucketRef, backup: BucketRef, expected: ExpectedObject[], day: string): Promise<CopyReport> {
  if (source.bucket === backup.bucket) throw new Error("BACKUP_SAME_BUCKET");
  const report: CopyReport = { copied: 0, alreadyPresent: 0, missingOrAlteredInSource: [], conflictingCopy: [], manifestKey: null };
  for (const o of expected) {
    const target = `${BACKUP_PREFIX}${o.key}`;
    const existing = await copyHash(backup, target);
    if (existing === o.sha256 && await readVerified(backup, target, o.sha256)) { report.alreadyPresent++; continue; }
    if (existing !== undefined) { report.conflictingCopy.push(o.key); continue; } // never overwrite a copy
    const body = await readVerified(source, o.key, o.sha256);
    if (!body) { report.missingOrAlteredInSource.push(o.key); continue; }
    await backup.s3.send(new PutObjectCommand({ Bucket: backup.bucket, Key: target, Body: body, ContentLength: body.byteLength,
      ContentType: o.key.endsWith(".png") ? "image/png" : "application/pdf", Metadata: { sha256: o.sha256 } }));
    if (await readVerified(backup, target, o.sha256)) report.copied++;
    else report.conflictingCopy.push(o.key);
  }
  const manifestKey = `${BACKUP_PREFIX}manifests/${day}.json`;
  const manifest = Buffer.from(JSON.stringify({ day, objects: expected.map((o) => ({ key: o.key, sha256: o.sha256 })),
    copied: report.copied, alreadyPresent: report.alreadyPresent,
    missingOrAlteredInSource: report.missingOrAlteredInSource, conflictingCopy: report.conflictingCopy }));
  if ((await copyHash(backup, manifestKey)) === undefined) {
    await backup.s3.send(new PutObjectCommand({ Bucket: backup.bucket, Key: manifestKey, Body: manifest, ContentType: "application/json" }));
    report.manifestKey = manifestKey;
  }
  return report;
}

/** Restore ONE object from the copy to the same key in the billing bucket, only if its hash matches. */
export async function restoreFromCopy(backup: BucketRef, source: BucketRef, key: string, expectedSha256: string): Promise<boolean> {
  const body = await readVerified(backup, `${BACKUP_PREFIX}${key}`, expectedSha256);
  if (!body) return false;
  await source.s3.send(new PutObjectCommand({ Bucket: source.bucket, Key: key, Body: body, ContentLength: body.byteLength,
    ContentType: key.endsWith(".png") ? "image/png" : "application/pdf", CacheControl: "private, no-store" }));
  return Boolean(await readVerified(source, key, expectedSha256));
}

/** SQL (read-only) for the expected objects: every invoice document and every logo an issued invoice used. */
export const EXPECTED_OBJECTS_SQL = `
  SELECT object_key AS key, sha256 FROM invoice_documents
  UNION
  SELECT DISTINCT issuer_snapshot->'logo'->>'key', issuer_snapshot->'logo'->>'sha256' FROM invoices
   WHERE issuer_snapshot ? 'logo' AND issuer_snapshot->'logo' <> 'null'::jsonb
  UNION
  SELECT logo_object_key, logo_sha256 FROM billing_settings WHERE logo_object_key IS NOT NULL
  ORDER BY 1`;

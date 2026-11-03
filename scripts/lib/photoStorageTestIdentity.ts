/**
 * Migration 145 (H1), disposable test databases only: every photo verifier
 * uses its own new local bucket, while the CI database keeps the photos of the
 * previous suites. This performs the documented OPERATOR binding for the
 * verifier's bucket (ops/145 procedure): write the identity marker to the
 * bucket, then replace the database's marker as the database owner.
 *
 * Refused unless ETNARA_DISPOSABLE_DB=true. Never used by the application.
 */
import { randomUUID } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type pg from "pg";

export async function bindTestPhotoBucket(owner: pg.Client, s3: S3Client, bucket: string): Promise<string> {
  if (process.env.ETNARA_DISPOSABLE_DB !== "true" || process.env.NODE_ENV === "production") throw new Error("Disposable test databases only");
  const exists = (await owner.query<{ ok: boolean }>(`SELECT to_regclass('public.photo_storage_identity') IS NOT NULL AS ok`)).rows[0]?.ok;
  if (!exists) return "NO_145";
  const marker = randomUUID();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "_etnara/storage-identity.json", Body: JSON.stringify({ marker }), ContentType: "application/json" }));
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL session_replication_role = replica"); // the table is append-only for everyone else
    await owner.query("DELETE FROM photo_storage_identity");
    await owner.query("INSERT INTO photo_storage_identity (marker, bound_by) VALUES ($1, 'operator')", [marker]);
    await owner.query("COMMIT");
  } catch (e) { await owner.query("ROLLBACK"); throw e; }
  const { resetPhotoStorageIdentityCacheForTests } = await import("../../src/modules/activityPhotos/storageIdentity.js");
  resetPhotoStorageIdentityCacheForTests();
  return marker;
}

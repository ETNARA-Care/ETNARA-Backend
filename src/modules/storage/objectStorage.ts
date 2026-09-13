import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("STORAGE_NOT_CONFIGURED");
    this.name = "StorageNotConfiguredError";
  }
}

function config() {
  const values = [env.STORAGE_ENDPOINT, env.STORAGE_REGION, env.STORAGE_BUCKET, env.STORAGE_ACCESS_KEY_ID, env.STORAGE_SECRET_ACCESS_KEY];
  if (values.some(Boolean) && !values.every(Boolean)) throw new StorageNotConfiguredError();
  if (!values.every(Boolean)) throw new StorageNotConfiguredError();
  return {
    endpoint: env.STORAGE_ENDPOINT!,
    region: env.STORAGE_REGION!,
    bucket: env.STORAGE_BUCKET!,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!,
  };
}

function client() {
  const storage = config();
  return {
    bucket: storage.bucket,
    s3: new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    }),
  };
}

export async function createPrivateUploadUrl(storageKey: string, contentType: string) {
  const { s3, bucket } = client();
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: storageKey, ContentType: contentType }), { expiresIn: 300 });
}

export async function inspectPrivateObject(storageKey: string) {
  const { s3, bucket } = client();
  const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
  return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? "" };
}

export async function createPrivateDownloadUrl(storageKey: string, filename: string, contentType: string) {
  const { s3, bucket } = client();
  const safeFilename = filename.replace(/["\\\r\n]/g, "_");
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ResponseContentType: contentType,
    ResponseContentDisposition: `inline; filename="${safeFilename}"`,
  }), { expiresIn: 300 });
}

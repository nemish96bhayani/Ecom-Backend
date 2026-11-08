import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

const client = env.S3_ACCESS_KEY_ID
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "" },
    })
  : null;

const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" } as const;

/** Presigned upload URL – files are always stored under the tenant's own prefix. */
export async function presignUpload(tenantId: string, folder: "products" | "branding" | "categories", contentType: string) {
  const ext = ALLOWED[contentType as keyof typeof ALLOWED];
  if (!ext) throw new AppError(400, "bad_file_type", "Upload a JPG, PNG, WebP or AVIF image");
  const key = `${tenantId}/${folder}/${nanoid(16)}.${ext}`;

  if (!client) {
    // When S3 is not configured (e.g. in local development / testing),
    // provide a local mock upload endpoint so merchants can upload images without AWS credentials.
    const baseUrl = env.PUBLIC_API_URL || "http://localhost:4000";
    const uploadUrl = `${baseUrl}/api/v1/admin/uploads/local/${encodeURIComponent(key)}`;
    const publicUrl = `${baseUrl}/media/${key}`;
    return { uploadUrl, publicUrl, key };
  }

  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn: 300 });
  const publicBase = env.S3_PUBLIC_BASE_URL || `${env.PUBLIC_API_URL}/media`;
  return { uploadUrl: url, publicUrl: `${publicBase}/${key}`, key };
}

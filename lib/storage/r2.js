import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

let _client;
function client() {
  if (_client) return _client;
  const endpoint = process.env.AWS_S3_ENDPOINT;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 not configured (AWS_S3_ENDPOINT / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)');
  }
  _client = new S3Client({
    region: process.env.AWS_S3_REGION || 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

/**
 * Upload a buffer to the configured R2 bucket and return the public URL.
 * Public URLs are unguessable when the key includes a UUID — sufficient for
 * voice-memo-class assets where AssemblyAI needs to GET it once and we GET
 * it once for speaker matching.
 */
export async function uploadBuffer({ buffer, key, contentType }) {
  const bucket = process.env.AWS_S3_BUCKET;
  const publicBase = process.env.AWS_PUBLIC_BASE_URL;
  if (!bucket) throw new Error('R2 not configured (AWS_S3_BUCKET)');
  if (!publicBase) throw new Error('R2 not configured (AWS_PUBLIC_BASE_URL)');
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${publicBase.replace(/\/$/, '')}/${key}`;
}

export function voiceMemoKey(extension = 'm4a') {
  return `voice-memos/${randomUUID()}.${extension}`;
}

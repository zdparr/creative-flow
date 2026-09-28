import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Where exported files live. Without one, exports are kept in Postgres (fine for a novella). */
export interface FileStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A short-lived download link that saves under `fileName`. */
  downloadUrl(key: string, fileName: string): Promise<string>;
}

/** S3 storage; credentials come from the standard AWS environment variables. */
export function s3FileStore(options: { bucket: string; region?: string }): FileStore {
  const client = new S3Client(options.region ? { region: options.region } : {});
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    downloadUrl(key, fileName) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: options.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${fileName}"`,
        }),
        { expiresIn: 300 },
      );
    },
  };
}

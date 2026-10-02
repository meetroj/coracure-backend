import { Injectable, Logger } from '@nestjs/common';

import { AppException, PlatformError } from '../common/errors';
import { env } from '../config/env.validation';

/**
 * The object store, with no opinion about what is in it.
 *
 * *** A CLIENT UPLOAD NEVER PASSES THROUGH THIS SERVICE. *** A client is
 * handed a short-lived signed URL and talks to the store directly, so an
 * upload cannot occupy an API worker and a stored file has no public address
 * at all: a `storage_key` is never returned to anyone, and a read is a fresh
 * signature that expires in minutes (SRS 6.1 - "links are not publicly
 * guessable"). `put()` is the one exception, and it proves the rule rather
 * than breaking it: it is for bytes the SERVER itself generated - a rendered
 * prescription PDF, never a client upload - where there is no client to hand
 * a URL to in the first place.
 *
 * This is deliberately generic. Two modules keep files under different access
 * rules - M-05's doctor credentials and M-10's patient files - and the rule is
 * the part that differs, not the signing. Each module declares its OWN token
 * and its own key policy, and both bind to the classes here, so a change to
 * encryption or to the client has one home rather than two that can drift.
 */
export interface SignedUrl {
  url: string;
  expiresInSeconds: number;
}

export interface ObjectStorage {
  /** A URL the client PUTs the file to, exactly once, within the TTL. */
  signUpload(key: string, contentType: string): Promise<SignedUrl>;
  /** A URL that opens the stored file, named for the browser's download bar. */
  signDownload(key: string, fileName: string): Promise<SignedUrl>;
  /**
   * The server writes bytes it generated itself - never a client upload, see
   * the module note above.
   */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Best effort: a file whose row never arrived, or whose row is gone. */
  remove(key: string): Promise<void>;
  /**
   * The object's size, read from the store rather than a column - it is the
   * one authoritative source (see `patient_files`'s note). Null when the
   * object is missing, or when there is nothing behind the key to ask (the
   * stub).
   */
  stat(key: string): Promise<{ sizeBytes: number } | null>;
}

/** Signing failed at the provider. Never the caller's fault, so never a 4xx. */
export function storageUnavailable(): AppException {
  return new AppException(
    PlatformError.STORAGE_UNAVAILABLE,
    'File storage is unavailable. Please try again.',
    503,
  );
}

/**
 * The name goes inside a quoted `Content-Disposition`, so a quote or a
 * backslash in it would end the header value early. Both are dropped rather
 * than escaped: this is a download label, not data anything reads back.
 */
export function safeFileName(fileName: string): string {
  return Array.from(fileName)
    .filter((character) => character !== '"' && character !== '\\')
    .join('');
}

/**
 * Signs against the real bucket. Credentials come from the environment - the
 * SDK's default provider chain also picks up an EC2 instance role, which is how
 * this runs in production without static keys.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly bucket = env().AWS_S3_BUCKET!;
  private readonly ttl = env().STORAGE_URL_TTL_SECONDS;

  async signUpload(key: string, contentType: string): Promise<SignedUrl> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const url = await this.sign(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        // Storage-level encryption, on top of the bucket's own default.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { url, expiresInSeconds: this.ttl };
  }

  async signDownload(key: string, fileName: string): Promise<SignedUrl> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const url = await this.sign(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // The stored key is a uuid; this puts the owner's own file name back on
        // the download without ever exposing the key itself.
        ResponseContentDisposition: `attachment; filename="${safeFileName(fileName)}"`,
      }),
    );
    return { url, expiresInSeconds: this.ttl };
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await (
        await this.client()
      ).send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, key }, 'Failed to write a generated object');
      throw storageUnavailable();
    }
  }

  async remove(key: string): Promise<void> {
    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // An orphaned object costs pennies; failing the request that noticed it
      // costs the uploader their file.
      this.logger.warn({ err: error, key }, 'Could not remove a stored object');
    }
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const head = await (
        await this.client()
      ).send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength === undefined ? null : { sizeBytes: head.ContentLength };
    } catch (error) {
      // Not found, or a transient failure - either way there is no size to
      // report, and a download can proceed without one.
      this.logger.warn({ err: error, key }, 'Could not read a stored object’s size');
      return null;
    }
  }

  private async sign(
    command:
      import('@aws-sdk/client-s3').PutObjectCommand | import('@aws-sdk/client-s3').GetObjectCommand,
  ): Promise<string> {
    try {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      return await getSignedUrl(await this.client(), command, { expiresIn: this.ttl });
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to sign a storage URL');
      throw storageUnavailable();
    }
  }

  // Built once, on first use, so a deployment that never touches storage never
  // constructs a client for it.
  private cached?: import('@aws-sdk/client-s3').S3Client;

  private async client(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (!this.cached) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const config = env();
      this.cached = new S3Client({
        region: config.AWS_REGION,
        ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: config.AWS_ACCESS_KEY_ID,
                secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      });
    }
    return this.cached;
  }
}

/**
 * Local development without a bucket. It signs a URL that goes NOWHERE - there
 * is no object store behind it and nothing is ever stored.
 *
 * That is enough to drive every flow above it: the client gets a key, the
 * confirm call writes the row, and the access rules are exercised in full. Only
 * the bytes are missing. `env.validation` refuses this provider in production,
 * so it cannot ship pretending to hold anything.
 */
/**
 * Where the stub tells a client to PUT.
 *
 * A device is not on the server's `localhost`, so this is configurable:
 * `STORAGE_STUB_BASE_URL` is what an Android phone on `adb reverse` or an
 * emulator on `10.0.2.2` needs. The default suits a desktop client.
 */
const stubBaseUrl = (): string => {
  const configured = process.env.STORAGE_STUB_BASE_URL?.replace(/\/+$/, '');
  const base = configured || `http://localhost:${env().PORT}`;
  return `${base}/${env().API_PREFIX}/v1`;
};

@Injectable()
export class StubObjectStorage implements ObjectStorage {
  private readonly ttl = env().STORAGE_URL_TTL_SECONDS;

  /**
   * Points at THIS service, not at `storage.invalid`.
   *
   * The unresolvable host was fine while no client had bytes to send. Once the
   * app grew a file picker it became a DNS failure in the middle of the
   * registration submit, which the app can only surface as "Network request
   * failed". `StubUploadController` accepts the PUT and discards it.
   */
  signUpload(key: string): Promise<SignedUrl> {
    return Promise.resolve({
      url: `${stubBaseUrl()}/dev/storage/${key}?stub=upload`,
      expiresInSeconds: this.ttl,
    });
  }

  signDownload(key: string): Promise<SignedUrl> {
    return Promise.resolve({
      url: `https://storage.invalid/${key}?stub=download`,
      expiresInSeconds: this.ttl,
    });
  }

  put(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  stat(): Promise<{ sizeBytes: number } | null> {
    return Promise.resolve(null);
  }
}

/** The class the environment selects. Both modules bind through this. */
export function objectStorageClass(): typeof S3ObjectStorage | typeof StubObjectStorage {
  return env().STORAGE_PROVIDER === 's3' ? S3ObjectStorage : StubObjectStorage;
}

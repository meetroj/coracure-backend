import { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Lets the stub sink accept the bytes a real bucket would.
 *
 * Fastify only parses `application/json` and urlencoded out of the box, so a
 * `PUT` carrying `image/jpeg` or `application/pdf` is refused with a 415
 * before any handler runs — which the app reports as a failed upload just as
 * opaquely as the DNS error this replaced.
 *
 * The body is read and thrown away: the stub stores nothing, and its `stat()`
 * already answers `null` so nothing downstream believes otherwise. Reading it
 * rather than ignoring it matters — the client is streaming a file and wants
 * its `PUT` to complete, not to be reset mid-body.
 *
 * Registered only when `STORAGE_PROVIDER` is `stub`, and production refuses
 * that provider outright.
 */
const BINARY_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const;

export function registerStubUploadParser(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  for (const type of BINARY_TYPES) {
    fastify.addContentTypeParser(type, { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
      done(null, { bytes: body.length });
    });
  }
}

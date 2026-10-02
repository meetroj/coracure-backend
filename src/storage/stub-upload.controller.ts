import { Controller, Put, HttpCode } from '@nestjs/common';

import { Public } from '../identity/public.decorator';

/**
 * The local stand-in for the bucket.
 *
 * *** THIS EXISTS BECAUSE `StubObjectStorage` SIGNS A URL THAT CANNOT BE PUT
 * TO. *** It used to sign `https://storage.invalid/...`, a reserved TLD that
 * never resolves. That was fine while the app had no file picker and therefore
 * no bytes to send; the moment the picker landed, every registration submit
 * died on a DNS failure the app could only report as "Network request failed".
 *
 * So the stub now signs a URL back at this service and this route swallows the
 * PUT. Nothing is stored — `stat()` on the stub already answers `null`, so no
 * other code believes there are bytes behind the key.
 *
 * It is `@Public` because a signed URL carries no bearer token: that is the
 * whole point of signing one. The key is already unguessable and the route
 * only exists when the provider is `stub`, which production refuses outright
 * (`env.validation.ts` — `STORAGE_PROVIDER` must be `s3` there).
 */
@Controller('dev/storage')
export class StubUploadController {
  /**
   * A plain trailing wildcard: a storage key contains slashes, and Fastify's
   * router refuses a NAMED wildcard ("Wildcard must be the last character in
   * the route"). The key is not read — nothing is stored under it.
   */
  @Public()
  @Put('*')
  @HttpCode(200)
  accept(): { ok: true } {
    return { ok: true };
  }
}

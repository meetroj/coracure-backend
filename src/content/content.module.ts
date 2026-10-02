import { Global, Module } from '@nestjs/common';

import { CONTENT_LIBRARY } from '../clinical/content-library';
import { AdminCareHubController, CareHubController } from './content.controller';
import { ContentService } from './content.service';

/**
 * M-18 Care Hub. Owns `content_items`, one table for seven kinds of content.
 *
 * *** THIS IS THE MODULE THAT CLOSES THE CONTENT PORT. ***
 *
 * M-15 declared `CONTENT_LIBRARY` and bound a deliberately closed default -
 * "nothing is recommendable, nothing resolves" - because FR-15.4's Care Hub
 * picks have to be checked against a library that did not exist yet. This
 * module replaces that binding, which is what turns a doctor's selection from
 * a list of unverified ids into something a patient can actually open.
 *
 * M-15 stopped providing its own default the moment this arrived: a module's
 * own provider wins over a global one, so leaving it in place would have kept
 * the library shut. Nothing in M-15 or M-16 changes; both go on calling the port.
 *
 * Global because M-16's Care Plan resolves recommendations through it and M-06
 * shelves its specialty red-flag references here.
 */
@Global()
@Module({
  controllers: [CareHubController, AdminCareHubController],
  providers: [ContentService, { provide: CONTENT_LIBRARY, useExisting: ContentService }],
  // *** BOTH ARE EXPORTED. *** A @Global() module shares only what it exports,
  // and the port is the half M-15 and M-16 actually depend on.
  exports: [ContentService, CONTENT_LIBRARY],
})
export class ContentModule {}

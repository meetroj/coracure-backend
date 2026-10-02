import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { LiveKitService } from './livekit.service';
import { AdminVideoController, VideoController, VideoWebhookController } from './video.controller';
import { DEFAULT_JOIN_WINDOW_MINUTES, JOIN_WINDOW_KEY, VideoService } from './video.service';

/**
 * M-14 Video Consultation. Owns `consultation_participants`, one row per
 * LiveKit connection.
 *
 * There is no LiveKit Server in this module, and there never will be. LiveKit
 * runs as its own container (see `livekit/livekit.yaml` and the compose file);
 * this module is the control plane that decides who may enter one of its rooms
 * and records what happened there (LiveKit_strategy 2, 36).
 *
 * It follows M-11 and M-12 for the reason FR-8.5 gives: a token is issued after
 * the consultation exists, has both its parties, and has been paid for. Global
 * because M-15 reads the session record when it closes a case, and M-16 reads
 * it when it decides whether a follow-up pathway starts.
 */
@Global()
@Module({
  controllers: [VideoController, VideoWebhookController, AdminVideoController],
  providers: [VideoService, LiveKitService],
  exports: [VideoService],
})
export class VideoModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** How early a scheduled consultation opens, as an admin-editable value. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: JOIN_WINDOW_KEY,
        value: DEFAULT_JOIN_WINDOW_MINUTES,
        description:
          'Minutes before its scheduled start that a consultation can be joined. Long enough for both parties to arrive and run the pre-call device check; short enough that a room is not open for hours before anyone is due. Instant consultations ignore it — they have no scheduled start.',
        schema: z.number().int().min(0).max(60),
        editableBy: ['operations'],
      },
    ]);
  }
}

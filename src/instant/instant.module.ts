import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import {
  ACCEPTANCE_WINDOW_KEY,
  DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  InstantRoutingService,
} from './instant-routing.service';
import {
  AdminInstantController,
  DoctorPresenceController,
  PatientInstantController,
} from './instant.controller';
import { OfferSweeperService } from './offer-sweeper.service';
import { PresenceService } from './presence.service';

/**
 * M-13 Presence and Instant Consult. Owns `instant_consultancy`.
 *
 * It owns the ROUTING, not the rule: who is next is asked of M-11's
 * `AssignmentService`, so language stays a hard requirement on every re-route
 * and there is one allocation rule in the platform rather than two.
 *
 * Global because M-14 needs to know a provider is in a call, and M-15 opens the
 * completion gate through `PresenceService` when documentation is finished.
 */
@Global()
@Module({
  controllers: [DoctorPresenceController, PatientInstantController, AdminInstantController],
  providers: [PresenceService, InstantRoutingService, OfferSweeperService],
  exports: [PresenceService, InstantRoutingService],
})
export class InstantModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** FR-10.6's acceptance window, as an admin-editable value. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: ACCEPTANCE_WINDOW_KEY,
        value: DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
        description:
          'Seconds a provider has to accept an instant request before it re-routes (FR-10.6). Long enough to notice a push, short enough that a patient is not left waiting on one person.',
        schema: z.number().int().min(15).max(600),
        editableBy: ['operations'],
      },
    ]);
  }
}

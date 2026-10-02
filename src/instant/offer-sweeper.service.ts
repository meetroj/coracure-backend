import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { InstantRoutingService } from './instant-routing.service';

/**
 * FR-10.6: an instant request that is not answered within its window times out
 * and is re-routed automatically.
 *
 * *** THIS IS WHAT MAKES THE ACCEPTANCE WINDOW REAL. *** Without it a provider
 * who never opens their phone parks a patient's request for ever, and the
 * patient sees a spinner rather than the next provider.
 *
 * Every ten seconds, because the window is measured in seconds and a minute's
 * granularity would more than double a patient's wait on every hop.
 */
@Injectable()
export class OfferSweeperService {
  private readonly logger = new Logger(OfferSweeperService.name);
  private running = false;

  constructor(private readonly routing: InstantRoutingService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async sweep(): Promise<void> {
    // Two instances will both run this. That is safe - every close is
    // conditional on the offer still being `pending`, so the second one matches
    // nothing. This guard is only about one instance overlapping itself.
    if (this.running) return;
    this.running = true;
    try {
      await this.routing.expireOpenOffers();
    } catch (error) {
      // A failed sweep must not stop the next one: the offers it missed are
      // still expired, and the following tick will find them.
      this.logger.error({ err: error }, 'Instant offer sweep failed');
    } finally {
      this.running = false;
    }
  }
}

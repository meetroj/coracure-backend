import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { BookingService } from './booking.service';

/**
 * FR-6.2: a held slot is released on timeout or failure.
 *
 * *** THIS IS WHAT MAKES THE HOLD SAFE TO TAKE. *** Without it an abandoned
 * checkout parks a provider's slot for ever, and the partial unique index that
 * stops double-booking would be the very thing keeping the slot dead. M-11 is
 * done when "an abandoned checkout always releases the slot", and this is the
 * always.
 *
 * A sweep rather than a per-hold timer: a timer lives in one process's memory
 * and dies with it, and a restart in the wrong minute would strand every hold
 * outstanding at the time.
 */
@Injectable()
export class HoldSweeperService {
  private readonly logger = new Logger(HoldSweeperService.name);
  private running = false;

  constructor(private readonly booking: BookingService) {}

  /**
   * Every minute. The hold is minutes long, so a slot is never dead for
   * meaningfully longer than it was held for.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    // Two instances will both run this, and that is fine - the update is
    // conditional on the row still being `pending_payment`, so the second one
    // simply matches nothing. This guard is only about one instance overlapping
    // ITSELF on a slow tick.
    if (this.running) return;
    this.running = true;
    try {
      await this.booking.releaseExpiredHolds();
    } catch (error) {
      // A failed sweep must not stop the next one. The holds it missed are
      // still expired, and the following tick will find them.
      this.logger.error({ err: error }, 'Slot-hold sweep failed');
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { ComplianceService } from './compliance.service';

export const RETENTION_SWEEP_ENABLED_KEY = 'compliance.retention_sweep_enabled';
/**
 * *** OFF UNTIL THE CLIENT TURNS IT ON. ***
 *
 * Every other sweeper in this codebase runs from the first boot, because what
 * they do is recoverable: a slot released early can be rebooked, an alert
 * raised twice can be closed. This one DELETES AUDIT ENTRIES, and an entry
 * deleted is gone - there is no undo and no second copy.
 *
 * SRS 5.3 makes the retention period the client's to set, and until their
 * counsel has signed a figure off the shipped default is a guess. A guess that
 * silently erases evidence on a schedule is not a default anybody should
 * inherit, so this ships disabled and the admin panel turns it on.
 */
export const DEFAULT_RETENTION_SWEEP_ENABLED = false;

const ENABLED = z.boolean();

/**
 * The scheduled half of SRS 5.3.
 *
 * `ComplianceService.applyRetention` is the operation; this is the clock. They
 * are separate so the operation stays callable by hand - a super admin running
 * it once and reading the count is how anybody would sanely test a retention
 * figure before letting it run unattended.
 */
@Injectable()
export class RetentionSweeperService {
  private readonly logger = new Logger(RetentionSweeperService.name);
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly compliance: ComplianceService,
  ) {}

  /**
   * Daily, not hourly.
   *
   * The opposite call from M-16's check-in sweep, and for the opposite reason.
   * A missed check-in hour costs a seventh of somebody's follow-up; a missed
   * retention day costs nothing at all, because an entry that was eight years
   * old this morning is eight years and a day old tomorrow. Running it rarely
   * is the conservative choice for an irreversible operation.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const enabled =
        (await this.config.get(RETENTION_SWEEP_ENABLED_KEY, ENABLED)) ??
        DEFAULT_RETENTION_SWEEP_ENABLED;
      if (!enabled) return;

      const days = await this.compliance.retentionDays();
      // Runs as the platform, not as a person: nobody clicked it. The audit
      // entry `applyRetention` writes records that, which is what separates a
      // scheduled retirement from an admin deleting something by hand.
      const { deleted } = await this.compliance.applyRetentionAsSystem();
      if (deleted > 0) {
        this.logger.log(
          { deleted, retentionDays: days },
          'Scheduled retention sweep retired entries',
        );
      }
    } catch (error) {
      // A failed sweep must not stop the next one. What it missed is still old,
      // and tomorrow's run will find it.
      this.logger.error({ err: error }, 'Scheduled retention sweep failed');
    } finally {
      this.running = false;
    }
  }
}

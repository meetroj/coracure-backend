import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConsultationStatus } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export const CONSULT_REMINDER_LEAD_MINUTES_KEY = 'booking.consult_reminder_lead_minutes';
/** FR-16.1's reminder. Long enough to still act on, short enough to be "now-ish". */
export const DEFAULT_CONSULT_REMINDER_LEAD_MINUTES = 30;

const LEAD_MINUTES = z.number().int().min(5).max(180);

/**
 * The `consult_reminder` template FR-16.1 asks for, and M-08 already fully
 * defines - this is the one missing piece: nothing ever triggered it.
 *
 * A sweep, for the reason every other timing rule in this codebase gives: a
 * per-booking timer lives in one process and dies with it. Sent at most once
 * per consultation, checked against `notifications` itself - the table that
 * already owns "was this sent" - rather than a new column that could disagree
 * with it.
 */
@Injectable()
export class ConsultReminderSweeperService {
  private readonly logger = new Logger(ConsultReminderSweeperService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.remindDueConsultations(now);
    } catch (error) {
      this.logger.error({ err: error }, 'Consult-reminder sweep failed');
    } finally {
      this.running = false;
    }
  }

  private async remindDueConsultations(now: Date): Promise<void> {
    const leadMinutes = await this.leadMinutes();
    const windowEnd = new Date(now.getTime() + leadMinutes * 60_000);

    const due = await this.prisma.consultation.findMany({
      where: {
        status: ConsultationStatus.scheduled,
        scheduledStartAt: { gt: now, lte: windowEnd },
      },
      select: {
        id: true,
        patientId: true,
        scheduledStartAt: true,
        doctor: { select: { fullName: true } },
      },
    });
    if (due.length === 0) return;

    const alreadySent = await this.prisma.notification.findMany({
      where: {
        templateCode: 'consult_reminder',
        consultationId: { in: due.map((consultation) => consultation.id) },
      },
      select: { consultationId: true },
    });
    const sent = new Set(alreadySent.map((row) => row.consultationId));

    for (const consultation of due) {
      if (sent.has(consultation.id) || !consultation.scheduledStartAt) continue;
      const minutesLeft = Math.max(
        1,
        Math.round((consultation.scheduledStartAt.getTime() - now.getTime()) / 60_000),
      );
      await this.notifications.notify({
        code: 'consult_reminder',
        to: { patientId: consultation.patientId },
        consultationId: consultation.id,
        variables: {
          doctorName: consultation.doctor?.fullName ?? 'your provider',
          consultationTime: consultation.scheduledStartAt.toISOString(),
          timeUntil: `in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`,
        },
        deepLink: { screen: 'consultation', consultationId: consultation.id },
      });
    }
  }

  private async leadMinutes(): Promise<number> {
    return (
      (await this.config.get(CONSULT_REMINDER_LEAD_MINUTES_KEY, LEAD_MINUTES)) ??
      DEFAULT_CONSULT_REMINDER_LEAD_MINUTES
    );
  }
}

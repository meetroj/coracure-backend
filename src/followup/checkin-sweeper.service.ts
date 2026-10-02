import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FollowupStatus, SafetyAlertType } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { env } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { startOfDay } from './followup.service';
import { followupDay, followupEndsOn } from './pathway';
import { SafetyAlertsService } from './safety-alerts.service';

export const MISSED_CHECKIN_THRESHOLD_KEY = 'followup.missed_checkin_threshold';
/**
 * How many missed days in a row raise an alert.
 *
 * Two, not one. A single missed day is a busy afternoon; two in a row is a
 * pattern, and FR-13.3 makes a missed check-in an amber rather than an
 * emergency. Set it to 1 and every patient who goes to bed early generates an
 * alert, which is how a governance queue stops being read.
 */
export const DEFAULT_MISSED_CHECKIN_THRESHOLD = 2;

const THRESHOLD = z.number().int().min(1).max(7);

export const CHECKIN_PROMPT_HOUR_KEY = 'followup.checkin_prompt_hour';
/**
 * The hour, in the platform's own time zone, at which the day's check-in prompt
 * goes out. Early evening: late enough that "how has today been" has an answer,
 * early enough that the patient is still awake to give it.
 */
export const DEFAULT_CHECKIN_PROMPT_HOUR = 18;

const PROMPT_HOUR = z.number().int().min(0).max(23);

/**
 * *** ABSENCE, DETECTED. FR-13.3 AND FR-9.8. ***
 *
 * A missed check-in is a MISSING `checkin_responses` row. Nothing writes "not
 * answered", so nothing has to remember to - but that also means nobody
 * notices unless somebody goes looking, and this is the going looking.
 *
 * A sweep rather than a timer per patient, for the reason M-11's hold sweeper
 * gives: a timer lives in one process's memory and dies with it, and a restart
 * at the wrong minute would silently drop the day's follow-up adherence for
 * every patient at once.
 */
@Injectable()
export class CheckinSweeperService {
  private readonly logger = new Logger(CheckinSweeperService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly alerts: SafetyAlertsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Once an hour rather than once a day.
   *
   * A daily job has one chance to run: if the process is down at that minute,
   * a day of missed check-ins goes unnoticed for a full day, which on a
   * seven-day window is a seventh of the whole follow-up. Hourly, every run is
   * idempotent and a missed hour costs an hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.closeFinishedWindows(now);
      await this.promptTodaysCheckins(now);
      await this.raiseMissedCheckins(now);
    } catch (error) {
      // A failed sweep must not stop the next one. What it missed is still
      // missing, and the following hour will find it.
      this.logger.error({ err: error }, 'Follow-up sweep failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * A follow-up whose window has passed becomes `completed`.
   *
   * The end date is `starts_on + duration_days` and is never stored, so this
   * computes it per row from the PINNED pathway rather than reading a column
   * that could have drifted from the pathway it belongs to.
   */
  private async closeFinishedWindows(now: Date): Promise<number> {
    const active = await this.prisma.consultation.findMany({
      where: { followupStatus: FollowupStatus.active, followupStartsOn: { not: null } },
      select: {
        id: true,
        followupStartsOn: true,
        followupPathway: { select: { durationDays: true } },
      },
    });

    const finished = active.filter((row) => {
      if (!row.followupStartsOn || !row.followupPathway) return false;
      return (
        startOfDay(now) > followupEndsOn(row.followupStartsOn, row.followupPathway.durationDays)
      );
    });
    if (finished.length === 0) return 0;

    await this.prisma.consultation.updateMany({
      where: { id: { in: finished.map((row) => row.id) } },
      data: { followupStatus: FollowupStatus.completed },
    });

    // FR-9.8's worklist item: the window is over, and somebody should look
    // back over the whole week rather than just its individual days. Raised
    // once here, not daily on every due check-in - a "due" alert every day of
    // an active follow-up would drown the queue in noise nobody could act on.
    for (const row of finished) {
      await this.alerts.raise({ alertType: SafetyAlertType.followup_due, consultationId: row.id });
    }

    this.logger.log({ completed: finished.length }, 'Closed finished follow-up windows');
    return finished.length;
  }

  /**
   * FR-16.1's daily prompt, for everyone in an open window who has not answered
   * yet today.
   *
   * Sent once per patient per day, and the proof of that is the `notifications`
   * row itself rather than a "prompted" column on the consultation: M-08
   * already records every send against the consultation, so a second source of
   * truth here could only disagree with it.
   */
  private async promptTodaysCheckins(now: Date): Promise<number> {
    const hour =
      (await this.config.get(CHECKIN_PROMPT_HOUR_KEY, PROMPT_HOUR)) ?? DEFAULT_CHECKIN_PROMPT_HOUR;
    const localHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: env().PLATFORM_TIMEZONE,
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
    // Only on the sweep that lands in the configured hour. Every other hourly
    // run does the missed-check-in work and sends nothing.
    if (localHour !== hour) return 0;

    const active = await this.prisma.consultation.findMany({
      where: { followupStatus: FollowupStatus.active, followupStartsOn: { not: null } },
      select: {
        id: true,
        patientId: true,
        followupStartsOn: true,
        followupPathway: { select: { durationDays: true } },
        checkinResponses: { where: { checkinDate: startOfDay(now) }, select: { id: true } },
      },
    });

    let sent = 0;
    for (const row of active) {
      if (!row.followupStartsOn || !row.followupPathway) continue;
      // Already answered today: prompting them is worse than saying nothing.
      if (row.checkinResponses.length > 0) continue;

      const day = followupDay(row.followupStartsOn, now);
      if (day < 1 || day > row.followupPathway.durationDays) continue;

      const alreadySent = await this.prisma.notification.findFirst({
        where: {
          consultationId: row.id,
          templateCode: 'checkin_due',
          createdAt: { gte: startOfDay(now) },
        },
        select: { id: true },
      });
      if (alreadySent) continue;

      await this.notifications.notify({
        code: 'checkin_due',
        to: { patientId: row.patientId },
        variables: { checkinDay: String(day) },
        consultationId: row.id,
        deepLink: { screen: 'checkin', consultationId: row.id },
      });
      sent += 1;
    }

    if (sent > 0) this.logger.log({ sent }, 'Sent daily check-in prompts');
    return sent;
  }

  /**
   * Patients who have stopped checking in.
   *
   * Only days that are fully PAST are counted. Today is not a missed day until
   * it is over, and alerting at 9am because somebody has not yet checked in is
   * how a care coordinator learns to ignore the queue.
   */
  private async raiseMissedCheckins(now: Date): Promise<number> {
    const threshold =
      (await this.config.get(MISSED_CHECKIN_THRESHOLD_KEY, THRESHOLD)) ??
      DEFAULT_MISSED_CHECKIN_THRESHOLD;

    const active = await this.prisma.consultation.findMany({
      where: { followupStatus: FollowupStatus.active, followupStartsOn: { not: null } },
      select: {
        id: true,
        patientId: true,
        followupStartsOn: true,
        followupPathway: { select: { durationDays: true } },
        checkinResponses: { select: { checkinDate: true } },
      },
    });

    let raised = 0;
    for (const row of active) {
      if (!row.followupStartsOn || !row.followupPathway) continue;

      const today = followupDay(row.followupStartsOn, now);
      // Days 1..today-1 are over. Today is still in play.
      const elapsed = Math.min(today - 1, row.followupPathway.durationDays);
      if (elapsed < threshold) continue;

      const answered = new Set(
        row.checkinResponses.map((response) => response.checkinDate.toISOString().slice(0, 10)),
      );
      const missed = countMissedRunEndingYesterday(row.followupStartsOn, elapsed, answered);
      if (missed < threshold) continue;

      // One alert per patient while the run continues, not one per missed day:
      // an open alert already says this patient has stopped answering, and a
      // second saying it louder helps nobody.
      const alreadyOpen = await this.prisma.safetyAlert.findFirst({
        where: {
          consultationId: row.id,
          alertType: SafetyAlertType.missed_checkin,
          closedAt: null,
        },
        select: { id: true },
      });
      if (alreadyOpen) continue;

      const patient = await this.prisma.patient.findUnique({
        where: { id: row.patientId },
        select: { fullName: true },
      });

      await this.alerts.raise({
        alertType: SafetyAlertType.missed_checkin,
        consultationId: row.id,
        reason: `No check-in for ${missed} days running.`,
        patientName: patient?.fullName ?? 'A patient',
        count: missed,
      });
      raised += 1;
    }

    if (raised > 0) this.logger.log({ raised }, 'Raised missed check-in alerts');
    return raised;
  }
}

/**
 * How many consecutive days ending YESTERDAY have no check-in.
 *
 * Counted backwards from the last finished day: a patient who missed days two
 * and three but answered on days four and five has not stopped, and the run
 * that matters is the one still going.
 */
export function countMissedRunEndingYesterday(
  startsOn: Date,
  elapsedDays: number,
  answeredDates: Set<string>,
): number {
  let missed = 0;
  for (let day = elapsedDays; day >= 1; day -= 1) {
    const date = new Date(startsOn);
    date.setUTCDate(date.getUTCDate() + day - 1);
    if (answeredDates.has(date.toISOString().slice(0, 10))) break;
    missed += 1;
  }
  return missed;
}

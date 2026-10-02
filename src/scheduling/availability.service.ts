import { HttpStatus, Injectable } from '@nestjs/common';
import { AvailabilityRuleType, ConsultationChannel, DoctorAvailability, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { env } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import {
  LocalDate,
  MINUTES_PER_DAY,
  MinutesOfDay,
  dateColumnFrom,
  dateKey,
  formatMinutes,
  localDateFromColumn,
  localDateOf,
  minutesFromTimeColumn,
  parseLocalDate,
  parseMinutes,
} from './local-time';
import { SchedulingError } from './scheduling.errors';

/** One standing window in the weekly pattern. Times are `HH:MM`, local. */
/** Every existing caller that omits it keeps getting both, unchanged. */
const DEFAULT_CHANNELS: ConsultationChannel[] = [
  ConsultationChannel.video,
  ConsultationChannel.audio,
];

export interface WeeklyWindowInput {
  /** 0 Sunday through 6 Saturday. */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  channels?: ConsultationChannel[];
}

export interface DatedWindowInput {
  /** `YYYY-MM-DD`, local. */
  date: string;
  /** Both omitted on a block means the whole day - a day of leave. */
  startTime?: string;
  endTime?: string;
  channels?: ConsultationChannel[];
}

export interface AvailabilityRuleRecord {
  id: string;
  dayOfWeek: number | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  channels: ConsultationChannel[];
}

/** A provider's whole diary, as the panel and the provider app read it. */
export interface DiaryRecord {
  doctorId: string;
  /** The wall clock these times are written in. Clients render in it, not in the device zone. */
  timeZone: string;
  /** From the doctor row. A bookable slot is the sum of the two (FR-10.7). */
  consultationDurationMinutes: number;
  bufferMinutes: number;
  weekly: AvailabilityRuleRecord[];
  /** Leave and gaps. A row with no times is a whole day. */
  blocked: AvailabilityRuleRecord[];
  /** Dates whose hours REPLACE the weekly pattern entirely. */
  customHours: AvailabilityRuleRecord[];
}

/** What the scheduler needs, with the column shapes already resolved. */
export interface ParsedRule {
  ruleType: AvailabilityRuleType;
  dayOfWeek: number | null;
  date: LocalDate | null;
  startMinutes: MinutesOfDay | null;
  endMinutes: MinutesOfDay | null;
  channels: ConsultationChannel[];
}

/**
 * M-07's first half: the rules themselves (FR-10.1). Working out what they add
 * up to is `SchedulingService`, which reads through here rather than touching
 * the table - `doctor_availability` has one owner.
 *
 * A provider and an admin write through the same methods. The admin pathway is
 * not a convenience: an absent provider has to be removable from the pool
 * without waiting for them to update their own diary, which is the whole reason
 * FR-10.1 gives the panel edit rights at all.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly doctors: DoctorRegistryService,
  ) {}

  private get timeZone(): string {
    return env().PLATFORM_TIMEZONE;
  }

  // -- Reads ----------------------------------------------------------------

  async diaryOf(doctorId: string): Promise<DiaryRecord> {
    const doctor = await this.doctors.getAccount(doctorId);
    const rows = await this.prisma.doctorAvailability.findMany({
      where: { doctorId },
      orderBy: [{ dayOfWeek: 'asc' }, { specificDate: 'asc' }, { startTime: 'asc' }],
    });

    const of = (type: AvailabilityRuleType) =>
      rows.filter((row) => row.ruleType === type).map(shape);

    return {
      doctorId,
      timeZone: this.timeZone,
      consultationDurationMinutes: doctor.consultationDurationMinutes,
      bufferMinutes: doctor.bufferMinutes,
      weekly: of(AvailabilityRuleType.weekly),
      blocked: of(AvailabilityRuleType.blocked),
      customHours: of(AvailabilityRuleType.custom_hours),
    };
  }

  /**
   * Every rule for a set of providers, parsed. One query for a whole pool: the
   * FR-10.7 admin view and assignment both ask about all the candidates at
   * once, and a query per candidate would not survive a real pool.
   */
  async rulesFor(doctorIds: string[]): Promise<Map<string, ParsedRule[]>> {
    const byDoctor = new Map<string, ParsedRule[]>(doctorIds.map((id) => [id, []]));
    if (doctorIds.length === 0) return byDoctor;

    const rows = await this.prisma.doctorAvailability.findMany({
      where: { doctorId: { in: doctorIds } },
    });
    for (const row of rows) {
      byDoctor.get(row.doctorId)?.push(parse(row));
    }
    return byDoctor;
  }

  // -- The weekly pattern ---------------------------------------------------

  /**
   * Replaces the standing pattern outright rather than adding to it.
   *
   * A diary is a statement about now, not a history, so an edit that left the
   * old rows in place would keep a provider bookable at hours they had just
   * removed. Replacing in one transaction also means the overlap check runs
   * against exactly what is being saved, never against a mixture of old and new.
   */
  async replaceWeekly(
    doctorId: string,
    windows: WeeklyWindowInput[],
    actor: AuthenticatedActor,
  ): Promise<DiaryRecord> {
    await this.doctors.getAccount(doctorId);

    const parsed = windows.map((window) => {
      const range = this.requireRange(window.startTime, window.endTime);
      return {
        dayOfWeek: window.dayOfWeek,
        start: range.start,
        end: range.end,
        channels: window.channels?.length ? window.channels : DEFAULT_CHANNELS,
      };
    });
    assertNoOverlap(
      parsed.map((window) => ({
        key: String(window.dayOfWeek),
        start: window.start,
        end: window.end,
      })),
      'weekday',
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.doctorAvailability.deleteMany({
        where: { doctorId, ruleType: AvailabilityRuleType.weekly },
      });
      for (const window of parsed) {
        await insertRule(tx, {
          doctorId,
          ruleType: AvailabilityRuleType.weekly,
          dayOfWeek: window.dayOfWeek,
          date: null,
          startMinutes: window.start,
          endMinutes: window.end,
          channels: window.channels,
        });
      }
    });

    await this.record(actor, 'update', doctorId, doctorId, {
      change: 'weekly_pattern',
      windows: parsed.length,
    });
    return this.diaryOf(doctorId);
  }

  // -- Dated rules ----------------------------------------------------------

  /**
   * Blocked time (FR-10.1). With no hours it is a whole day of leave; with
   * hours it is a gap inside an otherwise normal day.
   *
   * A block always wins over the hours it covers, whether those came from the
   * weekly pattern or from a `custom_hours` override, so an admin taking an
   * absent provider out of the pool never has to find and edit the rule that
   * put them in it.
   */
  async block(
    doctorId: string,
    input: DatedWindowInput,
    actor: AuthenticatedActor,
  ): Promise<AvailabilityRuleRecord> {
    await this.doctors.getAccount(doctorId);
    const date = this.requireDateNotPast(input.date);

    const wholeDay = input.startTime === undefined && input.endTime === undefined;
    if (!wholeDay && (input.startTime === undefined || input.endTime === undefined)) {
      throw new AppException(
        SchedulingError.INVALID_TIME_RANGE,
        'Block either a whole day, by sending no times, or a window, by sending both.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const range = wholeDay ? null : this.requireRange(input.startTime!, input.endTime!);

    // Overlapping BLOCKS are allowed, unlike overlapping availability. Taking
    // the same time away twice takes the same time away, so two overlapping
    // blocks say something well defined; two overlapping windows do not.
    const created = await insertRule(this.prisma, {
      doctorId,
      ruleType: AvailabilityRuleType.blocked,
      dayOfWeek: null,
      date,
      startMinutes: range?.start ?? null,
      endMinutes: range?.end ?? null,
      channels: input.channels?.length ? input.channels : DEFAULT_CHANNELS,
    });

    await this.record(actor, 'create', doctorId, created.id, {
      rule: 'blocked',
      date: dateKey(date),
      wholeDay,
    });
    return shape(created);
  }

  /**
   * Hours for one date that REPLACE the weekly pattern for that date (FR-10.1).
   * Not added to it: a provider who says "on the 14th I work 14:00 to 18:00"
   * means instead of their usual Monday, not as well as it.
   */
  async setCustomHours(
    doctorId: string,
    input: DatedWindowInput,
    actor: AuthenticatedActor,
  ): Promise<AvailabilityRuleRecord> {
    await this.doctors.getAccount(doctorId);
    const date = this.requireDateNotPast(input.date);
    if (input.startTime === undefined || input.endTime === undefined) {
      throw new AppException(
        SchedulingError.INVALID_TIME_RANGE,
        'Custom hours need both a start and an end time.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const range = this.requireRange(input.startTime, input.endTime);

    const existing = await this.prisma.doctorAvailability.findMany({
      where: {
        doctorId,
        ruleType: AvailabilityRuleType.custom_hours,
        specificDate: dateColumnFrom(date),
      },
    });
    assertNoOverlap(
      [
        ...existing.map((row) => {
          const other = parse(row);
          return { key: input.date, start: other.startMinutes ?? 0, end: other.endMinutes ?? 0 };
        }),
        { key: input.date, start: range.start, end: range.end },
      ],
      'date',
    );

    const created = await insertRule(this.prisma, {
      doctorId,
      ruleType: AvailabilityRuleType.custom_hours,
      dayOfWeek: null,
      date,
      startMinutes: range.start,
      endMinutes: range.end,
      channels: input.channels?.length ? input.channels : DEFAULT_CHANNELS,
    });

    await this.record(actor, 'create', doctorId, created.id, {
      rule: 'custom_hours',
      date: dateKey(date),
      startTime: formatMinutes(range.start),
      endTime: formatMinutes(range.end),
    });
    return shape(created);
  }

  /** Removes one rule. Scoped by `doctorId`, so an id from another diary reads as absent. */
  async removeRule(doctorId: string, ruleId: string, actor: AuthenticatedActor): Promise<void> {
    const removed = await this.prisma.doctorAvailability.deleteMany({
      where: { id: ruleId, doctorId },
    });
    if (removed.count === 0) {
      throw new AppException(
        SchedulingError.AVAILABILITY_RULE_NOT_FOUND,
        'That availability rule does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.record(actor, 'delete', doctorId, ruleId, { rule: 'removed' });
  }

  // -- Internals ------------------------------------------------------------

  private requireRange(startTime: string, endTime: string): { start: number; end: number } {
    const start = parseMinutes(startTime);
    const end = parseMinutes(endTime);
    if (!(start >= 0 && end <= MINUTES_PER_DAY && start < end)) {
      throw new AppException(
        SchedulingError.INVALID_TIME_RANGE,
        `${startTime} to ${endTime} is not a window that moves forwards within one day.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return { start, end };
  }

  /**
   * Today counts; yesterday does not. Blocking a date that has gone changes
   * nothing about who can be booked, so accepting it would only ever leave a
   * diary full of rows that mean nothing.
   */
  private requireDateNotPast(value: string): LocalDate {
    const date = parseLocalDate(value);
    const today = localDateOf(new Date(), this.timeZone);
    if (dateKey(date) < dateKey(today)) {
      throw new AppException(
        SchedulingError.DATE_IN_THE_PAST,
        `${value} has already gone. Availability can only be changed from today onwards.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return date;
  }

  private record(
    actor: AuthenticatedActor,
    action: 'create' | 'update' | 'delete',
    doctorId: string,
    entityId: string,
    metadata: Record<string, Prisma.InputJsonValue>,
  ): Promise<void> {
    return this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action,
      entityType: 'doctor_availability',
      entityId,
      // An admin edit and a provider's own edit write the same row, so the
      // entry has to name whose diary it was as well as who changed it.
      metadata: { doctorId, ...metadata },
    });
  }
}

/**
 * *** WHY THIS IS RAW SQL. ***
 *
 * Postgres accepts `24:00:00` in a `time` column, and a diary needs it: a window
 * that ends at midnight has to MEET the next day's `00:00` window exactly, or
 * the two stop merging and a night shift reads as two short runs with a gap
 * between them (FR-10.7 asks about UNBROKEN time).
 *
 * Prisma writes a `time` from a JS Date and keeps only the time of day, so
 * 24:00 - which is 1440 minutes, i.e. the next day at 00:00 - arrives as
 * `00:00:00` and trips the `start_time < end_time` CHECK. There is no Date that
 * serialises to 24:00.
 *
 * So the times are written as literals and everything else stays Prisma. Reads
 * need no special case: Prisma hands `24:00:00` back as 1970-01-02T00:00Z, and
 * `minutesFromTimeColumn` already counts the day rollover.
 */
async function insertRule(
  client: Prisma.TransactionClient | PrismaService,
  rule: {
    doctorId: string;
    ruleType: AvailabilityRuleType;
    dayOfWeek: number | null;
    date: LocalDate | null;
    startMinutes: MinutesOfDay | null;
    endMinutes: MinutesOfDay | null;
    channels: ConsultationChannel[];
  },
): Promise<DoctorAvailability> {
  const [row] = await client.$queryRaw<DoctorAvailability[]>`
    INSERT INTO doctor_availability (doctor_id, rule_type, day_of_week, specific_date, start_time, end_time, channels)
    VALUES (
      ${rule.doctorId}::uuid,
      ${rule.ruleType}::availability_rule_type,
      ${rule.dayOfWeek},
      ${rule.date ? dateKey(rule.date) : null}::date,
      ${rule.startMinutes === null ? null : formatMinutes(rule.startMinutes)}::time,
      ${rule.endMinutes === null ? null : formatMinutes(rule.endMinutes)}::time,
      ${rule.channels}::consultation_channel[]
    )
    RETURNING
      id,
      doctor_id AS "doctorId",
      rule_type AS "ruleType",
      day_of_week AS "dayOfWeek",
      specific_date AS "specificDate",
      start_time AS "startTime",
      end_time AS "endTime",
      channels,
      created_at AS "createdAt"
  `;
  return row;
}

function parse(row: DoctorAvailability): ParsedRule {
  return {
    ruleType: row.ruleType,
    dayOfWeek: row.dayOfWeek,
    date: row.specificDate ? localDateFromColumn(row.specificDate) : null,
    startMinutes: minutesFromTimeColumn(row.startTime),
    endMinutes: minutesFromTimeColumn(row.endTime),
    channels: row.channels?.length ? row.channels : DEFAULT_CHANNELS,
  };
}

function shape(row: DoctorAvailability): AvailabilityRuleRecord {
  const parsed = parse(row);
  return {
    id: row.id,
    dayOfWeek: parsed.dayOfWeek,
    date: parsed.date ? dateKey(parsed.date) : null,
    startTime: parsed.startMinutes === null ? null : formatMinutes(parsed.startMinutes),
    endTime: parsed.endMinutes === null ? null : formatMinutes(parsed.endMinutes),
    channels: parsed.channels,
  };
}

/**
 * Two availability windows on the same weekday, or the same date, must not
 * cover the same minute. The union of two overlapping windows is perfectly well
 * defined, so this is not a correctness need - it is that a diary saying 9-13
 * and 11-17 is almost always an edit that went wrong, and the provider should
 * be told rather than have it quietly saved as 9-17.
 */
function assertNoOverlap(
  windows: { key: string; start: number; end: number }[],
  scope: 'weekday' | 'date',
): void {
  const byKey = new Map<string, { start: number; end: number }[]>();
  for (const window of windows) {
    const group = byKey.get(window.key) ?? [];
    group.push({ start: window.start, end: window.end });
    byKey.set(window.key, group);
  }

  for (const [key, group] of byKey) {
    const sorted = [...group].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index += 1) {
      const earlier = sorted[index - 1];
      const later = sorted[index];
      if (later.start < earlier.end) {
        const first = `${formatMinutes(earlier.start)}-${formatMinutes(earlier.end)}`;
        const second = `${formatMinutes(later.start)}-${formatMinutes(later.end)}`;
        throw new AppException(
          SchedulingError.OVERLAPPING_AVAILABILITY,
          `Two windows on the same ${scope} (${key}) overlap: ${first} and ${second}.`,
          HttpStatus.CONFLICT,
        );
      }
    }
  }
}

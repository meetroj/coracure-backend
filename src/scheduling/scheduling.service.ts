import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AvailabilityRuleType, DoctorVerificationStatus } from '@prisma/client';

import { AppException } from '../common/errors';
import { env } from '../config/env.validation';
import { DoctorBookingProfile, DoctorRegistryService } from '../doctors/doctor-registry.service';
import { AvailabilityService, ParsedRule } from './availability.service';
import { BOOKED_INTERVALS, BookedIntervals } from './booked-intervals';
import {
  Interval,
  addMinutes,
  clip,
  holds,
  minutesLong,
  normalise,
  subtract,
  surrounding,
} from './intervals';
import { LocalDate, addDays, dateKey, instantOf, localDatesBetween, weekdayOf } from './local-time';
import { SchedulingError } from './scheduling.errors';

/**
 * A bookable start. `endsAt` is when the consultation ends; the buffer that
 * follows it is not shown, because it is not time the patient is offered.
 */
export interface SlotRecord {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
}

/** FR-10.7, per provider: how long they are free for, from a given moment. */
export interface RemainingAvailability {
  doctorId: string;
  /** Minutes of UNBROKEN free time from that moment. 0 when they are not free at all. */
  availableMinutes: number;
  /** Consultation duration plus buffer - what a booking would actually occupy. */
  requiredMinutes: number;
  /** `availableMinutes >= requiredMinutes`, and the provider is verified and listed. */
  assignable: boolean;
}

/**
 * More than two months of slots in one lookup is a client that means to page,
 * or one that has got its dates the wrong way round. Either way the answer is
 * an error, not a computation over a year of diary.
 */
export const MAX_LOOKUP_DAYS = 62;

/**
 * How far past a moment the scheduler looks when asked how long a provider is
 * free FOR. Nothing sensible needs more: a consultation that ran two days
 * unbroken would be a data problem, not a long appointment.
 */
const REMAINING_HORIZON_DAYS = 2;

/** How many providers the FR-10.7 panel view measures at once. A pool larger than this is a filter the admin has not applied yet. */
const POOL_VIEW_LIMIT = 200;

/**
 * How far ahead `soonestForPool` looks. Four weeks is well past the point where
 * "the soonest we can see you" stops being a useful thing to show a patient -
 * beyond it, the honest answer is that the pool cannot cover this.
 */
const SOONEST_HORIZON_DAYS = 28;

/**
 * M-07's second half: what the rules add up to.
 *
 * *** THERE IS NO SLOTS TABLE. *** Every answer here is computed on demand from
 * three things - the availability rules, the blocks that take time out of them,
 * and the consultations that already occupy time. A generated slots table would
 * be a second copy of all three, it would need a horizon nobody can pick, and
 * every diary edit and every cancellation would have to rewrite it. The one
 * thing worse than computing this each time is showing a patient a slot that a
 * stale row says is free.
 *
 * Two callers matter. The provider and the admin read `slotsFor` to see a
 * diary. M-11 and M-13 call `remainingFor` to filter a pool and `assertFree`
 * before they write a consultation.
 */
@Injectable()
export class SchedulingService {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly doctors: DoctorRegistryService,
    @Inject(BOOKED_INTERVALS) private readonly booked: BookedIntervals,
  ) {}

  private get timeZone(): string {
    return env().PLATFORM_TIMEZONE;
  }

  // -- Free time ------------------------------------------------------------

  /**
   * When each provider is free inside `[from, to)`: their hours, minus blocks
   * and leave, minus what is already booked.
   *
   * The days either side of the window are computed too and then clipped away.
   * A provider working 22:00 to 02:00 has one unbroken window that belongs to
   * two calendar dates, and a lookup starting at midnight that ignored the day
   * before would report the second half of it as a separate, shorter window.
   */
  async freeIntervalsFor(
    doctorIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, Interval[]>> {
    const window: Interval = { startsAt: from, endsAt: to };
    if (to.getTime() <= from.getTime()) {
      return new Map(doctorIds.map((id) => [id, []]));
    }
    this.assertRangeIsSane(from, to);

    const dates = localDatesBetween(
      addMinutes(from, -24 * 60),
      addMinutes(to, 24 * 60),
      this.timeZone,
    );
    const [rules, booked] = await Promise.all([
      this.availability.rulesFor(doctorIds),
      this.booked.forDoctors(doctorIds, addMinutes(from, -24 * 60), addMinutes(to, 24 * 60)),
    ]);

    const free = new Map<string, Interval[]>();
    for (const doctorId of doctorIds) {
      const offered = this.offeredIntervals(rules.get(doctorId) ?? [], dates);
      free.set(doctorId, clip(subtract(offered, booked.get(doctorId) ?? []), window));
    }
    return free;
  }

  /** The same, for one provider. */
  async freeIntervals(doctorId: string, from: Date, to: Date): Promise<Interval[]> {
    return (await this.freeIntervalsFor([doctorId], from, to)).get(doctorId) ?? [];
  }

  // -- Slots ----------------------------------------------------------------

  /**
   * The bookable starts inside a window (FR-10.1).
   *
   * A slot is offered only where the whole of `duration + buffer` fits, which
   * is the same rule FR-10.7 states for assignment - a provider with ten
   * minutes left is not bookable for a thirty-minute consultation, and a slot
   * list that said otherwise would be an invitation to a booking that the
   * conflict guard would then refuse.
   *
   * Starts are laid out from the beginning of each free window rather than
   * snapped to the clock. A provider free from 09:10 offers 09:10, not 09:30:
   * the diary is theirs, and rounding it away loses them a consultation a day.
   */
  async slotsFor(doctorId: string, from: Date, to: Date, now = new Date()): Promise<SlotRecord[]> {
    const profile = await this.profileOf(doctorId);
    // Never offer a slot that has already started. The window is trimmed rather
    // than the results filtered, so the arithmetic below never runs on the past.
    const start = new Date(Math.max(from.getTime(), now.getTime()));
    if (to.getTime() <= start.getTime()) return [];

    const free = await this.freeIntervals(doctorId, start, to);
    return slotsIn(free, profile.consultationDurationMinutes, profile.bufferMinutes);
  }

  // -- FR-10.7 --------------------------------------------------------------

  /**
   * *** HOW LONG IS THIS PROVIDER FREE FOR, FROM THIS MOMENT ***
   *
   * FR-10.7, and the question this whole module exists to answer. Assignment
   * cannot ask merely whether a provider is free at 15:00: one who is free at
   * 15:00 and booked at 15:10 is not assignable to a thirty-minute
   * consultation, and a system that assigned them would have the patient and
   * the provider discover it in the video room.
   *
   * The answer is the UNBROKEN run from `at`, so a booking later in the
   * afternoon caps it and a gap does not quietly get counted as free time.
   * `assignable` also folds in verification and listing, because a provider who
   * cannot be booked at all is not made assignable by an empty diary.
   */
  async remainingFor(doctorIds: string[], at: Date): Promise<RemainingAvailability[]> {
    if (doctorIds.length === 0) return [];
    const profiles = await this.doctors.bookingProfilesOf(doctorIds);
    const free = await this.freeIntervalsFor(
      doctorIds,
      at,
      addMinutes(at, REMAINING_HORIZON_DAYS * 24 * 60),
    );

    return doctorIds.map((doctorId) => {
      const profile = profiles.get(doctorId);
      const requiredMinutes = profile
        ? profile.consultationDurationMinutes + profile.bufferMinutes
        : 0;
      const run = surrounding(normalise(free.get(doctorId) ?? []), at);
      const availableMinutes = run ? minutesLong({ startsAt: at, endsAt: run.endsAt }) : 0;
      return {
        doctorId,
        availableMinutes,
        requiredMinutes,
        assignable:
          Boolean(profile?.isBookable) &&
          requiredMinutes > 0 &&
          availableMinutes >= requiredMinutes,
      };
    });
  }

  /** The pool filter M-11 and M-13 call: who of these can actually take a case now. */
  async assignableAt(doctorIds: string[], at: Date): Promise<string[]> {
    const remaining = await this.remainingFor(doctorIds, at);
    return remaining.filter((entry) => entry.assignable).map((entry) => entry.doctorId);
  }

  /**
   * The same answer for a whole service, with names attached: FR-10.7's "the
   * admin panel shows available duration per provider for a chosen time, which
   * is how an admin checks and overrides an allocation".
   *
   * Only verified and listed providers are considered, and the filter takes the
   * same three inputs assignment does - service, language and region (FR-20.2).
   * An admin overriding an allocation is choosing among people who could have
   * been allocated, and showing them a provider who was never in the pool would
   * make the override look like the system had made a mistake.
   *
   * Language especially: FR-20.4 never relaxes it, so a panel that could not
   * filter on it would offer an admin providers who cannot speak to the
   * patient.
   */
  async remainingAcrossPool(
    filter: { specialtyId?: string; regionId?: string; language?: string },
    at: Date,
  ): Promise<(RemainingAvailability & { fullName: string })[]> {
    const pool = await this.doctors.listForAdmin({
      ...filter,
      verificationStatus: DoctorVerificationStatus.verified,
      isListed: true,
      limit: POOL_VIEW_LIMIT,
    });
    const names = new Map(pool.map((doctor) => [doctor.id, doctor.fullName]));
    const remaining = await this.remainingFor([...names.keys()], at);
    return (
      remaining
        .map((entry) => ({ ...entry, fullName: names.get(entry.doctorId) ?? '' }))
        // Longest free run first: an admin looking for somewhere to move a case
        // is looking for the provider with the most room, not the first by name.
        .sort((a, b) => b.availableMinutes - a.availableMinutes)
    );
  }

  /**
   * *** WHEN CAN THIS SERVICE NEXT BE COVERED? ***
   *
   * The soonest bookable start anywhere in a specialty's pool, or null if
   * nothing inside the horizon. FR-5.4 puts this beside the fee on every search
   * result, and FR-6.1 makes it what a patient is offered: since SRS 1.3 the
   * times shown are the times the POOL can cover, never one provider's diary.
   *
   * It lives here, and not in M-09, for the reason MODULES gives for M-09 no
   * longer depending on M-05: the caller asks about a service and never sees the
   * roster. Resolving which providers are in the pool is scheduling's business.
   *
   * `language` matters as much here as it does in assignment. FR-20.7 offers a
   * refused patient the next time the pool can cover them - and a time only a
   * provider who cannot speak to them is free at is not a time that covers
   * them. Left out, this quietly promises a slot the booking would refuse again.
   */
  async soonestForPool(
    filter: { specialtyId?: string; regionId?: string; language?: string },
    from: Date,
    withinDays = SOONEST_HORIZON_DAYS,
  ): Promise<Date | null> {
    const pool = await this.doctors.listForAdmin({
      ...filter,
      verificationStatus: DoctorVerificationStatus.verified,
      isListed: true,
      limit: POOL_VIEW_LIMIT,
    });
    if (pool.length === 0) return null;

    const to = addMinutes(from, withinDays * 24 * 60);
    const doctorIds = pool.map((doctor) => doctor.id);
    const [free, profiles] = await Promise.all([
      this.freeIntervalsFor(doctorIds, from, to),
      this.doctors.bookingProfilesOf(doctorIds),
    ]);

    let soonest: Date | null = null;
    for (const doctorId of doctorIds) {
      const profile = profiles.get(doctorId);
      if (!profile?.isBookable) continue;
      // Each provider's own slot length: a pool can hold a thirty-minute and a
      // fifty-minute diary, and what fits one does not fit the other.
      const [first] = slotsIn(
        free.get(doctorId) ?? [],
        profile.consultationDurationMinutes,
        profile.bufferMinutes,
      );
      if (first && (!soonest || first.startsAt < soonest)) soonest = first.startsAt;
    }
    return soonest;
  }

  // -- The conflict guard ---------------------------------------------------

  /**
   * *** TWO PATIENTS CANNOT TAKE THE SAME SLOT ***
   *
   * The check M-11 makes inside the transaction that writes a consultation: the
   * provider must be bookable, and the whole of `duration + buffer` from
   * `startsAt` must sit inside ONE free run - not spread across two windows
   * with a booking or a break between them.
   *
   * This is the first of two locks, not the only one. A check and a write are
   * two statements, and two requests can pass the check before either writes.
   * The last word is the partial unique index on
   * `consultations (doctor_id, scheduled_start_at)` for live statuses, which
   * M-11 adds with the table - see `db/schema.dbml`. This guard is what turns
   * that collision into a clear refusal instead of a constraint violation, and
   * what catches the far commoner case of a slot that was never offered.
   */
  async assertFree(doctorId: string, startsAt: Date, now = new Date()): Promise<void> {
    await this.doctors.assertBookable(doctorId);
    const profile = await this.profileOf(doctorId);
    const occupies: Interval = {
      startsAt,
      endsAt: addMinutes(startsAt, profile.consultationDurationMinutes + profile.bufferMinutes),
    };

    if (startsAt.getTime() < now.getTime()) {
      throw new AppException(
        SchedulingError.SLOT_UNAVAILABLE,
        'That time has already passed.',
        HttpStatus.CONFLICT,
      );
    }

    const free = await this.freeIntervals(doctorId, occupies.startsAt, occupies.endsAt);
    // `freeIntervals` clips to the window asked for, so a run that merely
    // reaches into it would look like a full match. The clipped result covering
    // the whole window is exactly the test that it did not.
    if (!holds(normalise(free), occupies)) {
      throw new AppException(
        SchedulingError.SLOT_UNAVAILABLE,
        'That slot is no longer free. Please choose another time.',
        HttpStatus.CONFLICT,
      );
    }
  }

  // -- Internals ------------------------------------------------------------

  /**
   * The hours a provider OFFERS on each date, before anything is booked.
   *
   * Precedence, in order, and it is the whole of the rule engine:
   *   1. a whole-day block removes the date outright - leave beats everything;
   *   2. `custom_hours` for that date REPLACE the weekly pattern, rather than
   *      adding to it, so an override is a different day and not a longer one;
   *   3. otherwise the weekly rows for that weekday apply;
   *   4. partial blocks are then subtracted from whichever of the two won.
   */
  private offeredIntervals(rules: ParsedRule[], dates: LocalDate[]): Interval[] {
    const byDate = new Map<string, ParsedRule[]>();
    const weekly: ParsedRule[] = [];
    for (const rule of rules) {
      if (rule.ruleType === AvailabilityRuleType.weekly) {
        weekly.push(rule);
        continue;
      }
      if (!rule.date) continue;
      const key = dateKey(rule.date);
      byDate.set(key, [...(byDate.get(key) ?? []), rule]);
    }

    const offered: Interval[] = [];
    for (const date of dates) {
      const dated = byDate.get(dateKey(date)) ?? [];
      const blocks = dated.filter((rule) => rule.ruleType === AvailabilityRuleType.blocked);

      if (blocks.some((block) => block.startMinutes === null)) continue;

      const custom = dated.filter((rule) => rule.ruleType === AvailabilityRuleType.custom_hours);
      const base =
        custom.length > 0 ? custom : weekly.filter((rule) => rule.dayOfWeek === weekdayOf(date));
      if (base.length === 0) continue;

      const windows = base.map((rule) => this.toInterval(date, rule));
      const holes = blocks.map((block) => this.toInterval(date, block));
      offered.push(...subtract(windows, holes));
    }
    // Normalised across dates, not within one: a window that ends at 24:00 and
    // one that starts at 00:00 the next day are the same unbroken run, and
    // FR-10.7 asks about unbroken runs.
    return normalise(offered);
  }

  /**
   * A local window on a local date, as instants. Minutes past midnight roll the
   * date forward, which is what lets a window end at 24:00 - the end of a day
   * and the start of the next are the same moment, and a diary should be able
   * to say either.
   */
  private toInterval(date: LocalDate, rule: ParsedRule): Interval {
    const start = rule.startMinutes ?? 0;
    const end = rule.endMinutes ?? 24 * 60;
    return {
      startsAt: instantOf(...rollOver(date, start), this.timeZone),
      endsAt: instantOf(...rollOver(date, end), this.timeZone),
    };
  }

  private async profileOf(doctorId: string): Promise<DoctorBookingProfile> {
    const profiles = await this.doctors.bookingProfilesOf([doctorId]);
    const profile = profiles.get(doctorId);
    // `getAccount` throws the module's own DOCTOR_NOT_FOUND, so an unknown
    // provider fails the same way here as it does everywhere else.
    if (!profile) await this.doctors.getAccount(doctorId);
    return profile as DoctorBookingProfile;
  }

  private assertRangeIsSane(from: Date, to: Date): void {
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_LOOKUP_DAYS) {
      throw new AppException(
        SchedulingError.RANGE_TOO_WIDE,
        `Ask for at most ${MAX_LOOKUP_DAYS} days of availability at a time.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

/** 24:00 on the 14th is 00:00 on the 15th. Keeps `instantOf` inside a real day. */
function rollOver(date: LocalDate, minutes: number): [LocalDate, number] {
  const days = Math.floor(minutes / (24 * 60));
  return [days === 0 ? date : addDays(date, days), minutes - days * 24 * 60];
}

/**
 * Lays slots along each free run. Exported so the rule can be tested on its own
 * - it is the arithmetic a patient sees, and an off-by-one here is a slot that
 * cannot be booked or a booking that overruns the provider's day.
 */
export function slotsIn(
  free: Interval[],
  durationMinutes: number,
  bufferMinutes: number,
): SlotRecord[] {
  const step = durationMinutes + bufferMinutes;
  if (step <= 0) return [];

  const slots: SlotRecord[] = [];
  for (const run of normalise(free)) {
    let startsAt = run.startsAt;
    while (addMinutes(startsAt, step).getTime() <= run.endsAt.getTime()) {
      slots.push({
        startsAt,
        endsAt: addMinutes(startsAt, durationMinutes),
        durationMinutes,
      });
      startsAt = addMinutes(startsAt, step);
    }
  }
  return slots;
}

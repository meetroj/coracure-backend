import { AvailabilityRuleType, ConsultationChannel } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { AvailabilityService, ParsedRule } from './availability.service';
import { BookedIntervals } from './booked-intervals';
import { Interval } from './intervals';
import { SchedulingService, slotsIn } from './scheduling.service';

const DOCTOR = 'doctor-1';
/** IST is UTC+5:30, so a 09:00 local start is 03:30Z. Every instant below is UTC. */
const IST_OFFSET = '+05:30';

/** A local wall-clock moment on the platform's zone, as the instant it happens. */
const local = (date: string, time: string) => new Date(`${date}T${time}:00.000${IST_OFFSET}`);

/** Monday 14 September 2026. */
const MONDAY = '2026-09-14';
const TUESDAY = '2026-09-15';

const BOTH_CHANNELS = [ConsultationChannel.video, ConsultationChannel.audio];

const weekly = (dayOfWeek: number, start: number, end: number): ParsedRule => ({
  ruleType: AvailabilityRuleType.weekly,
  dayOfWeek,
  date: null,
  startMinutes: start * 60,
  endMinutes: end * 60,
  channels: BOTH_CHANNELS,
});

const dated = (
  ruleType: AvailabilityRuleType,
  date: string,
  start: number | null,
  end: number | null,
): ParsedRule => {
  const [year, month, day] = date.split('-').map(Number);
  return {
    ruleType,
    dayOfWeek: null,
    date: { year, month, day },
    startMinutes: start === null ? null : start * 60,
    endMinutes: end === null ? null : end * 60,
    channels: BOTH_CHANNELS,
  };
};

const blocked = (date: string, start: number | null = null, end: number | null = null) =>
  dated(AvailabilityRuleType.blocked, date, start, end);
const customHours = (date: string, start: number, end: number) =>
  dated(AvailabilityRuleType.custom_hours, date, start, end);

const show = (intervals: Interval[]) =>
  intervals.map((interval) => [interval.startsAt.toISOString(), interval.endsAt.toISOString()]);

const times = (slots: { startsAt: Date }[]) => slots.map((slot) => slot.startsAt.toISOString());

function build(
  over: {
    rules?: ParsedRule[];
    booked?: Interval[];
    durationMinutes?: number;
    bufferMinutes?: number;
    isBookable?: boolean;
    pool?: { id: string; fullName: string }[];
  } = {},
) {
  const rulesFor = vi
    .fn<(ids: string[]) => Promise<Map<string, ParsedRule[]>>>()
    .mockImplementation((ids) => Promise.resolve(new Map(ids.map((id) => [id, over.rules ?? []]))));
  const availability = { rulesFor } as unknown as AvailabilityService;

  const profile = {
    id: DOCTOR,
    consultationDurationMinutes: over.durationMinutes ?? 30,
    bufferMinutes: over.bufferMinutes ?? 5,
    isBookable: over.isBookable ?? true,
  };
  const assertBookable = vi.fn<(doctorId: string) => Promise<void>>().mockResolvedValue(undefined);
  const bookingProfilesOf = vi
    .fn<(ids: string[]) => Promise<Map<string, typeof profile>>>()
    .mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, { ...profile, id }]))),
    );
  const getAccount = vi
    .fn<(doctorId: string) => Promise<typeof profile>>()
    .mockResolvedValue(profile);
  const listForAdmin = vi
    .fn<(filter: Record<string, unknown>) => Promise<{ id: string; fullName: string }[]>>()
    .mockResolvedValue(over.pool ?? []);
  const doctors = {
    bookingProfilesOf,
    getAccount,
    assertBookable,
    listForAdmin,
  } as unknown as DoctorRegistryService;

  const forDoctors = vi
    .fn<(ids: string[]) => Promise<Map<string, Interval[]>>>()
    .mockImplementation((ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, over.booked ?? []]))),
    );
  const booked = { forDoctors } as BookedIntervals;

  return {
    service: new SchedulingService(availability, doctors, booked),
    assertBookable,
    listForAdmin,
  };
}

describe('SchedulingService', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      PLATFORM_TIMEZONE: 'Asia/Kolkata',
    });
  });

  // -- The rule engine ------------------------------------------------------

  it('turns a weekly pattern into free time on the days it names', () => {
    // Monday is in the pattern, Tuesday is not.
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    return service
      .freeIntervals(DOCTOR, local(MONDAY, '00:00'), local(TUESDAY, '23:59'))
      .then((free) => {
        expect(show(free)).toEqual([
          [local(MONDAY, '09:00').toISOString(), local(MONDAY, '17:00').toISOString()],
        ]);
      });
  });

  it('lets a whole day of leave beat the weekly pattern', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17), blocked(MONDAY)] });
    const free = await service.freeIntervals(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
    );
    expect(free).toEqual([]);
  });

  it('cuts a blocked window out of the middle of a normal day', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17), blocked(MONDAY, 12, 13)] });
    const free = await service.freeIntervals(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
    );
    expect(show(free)).toEqual([
      [local(MONDAY, '09:00').toISOString(), local(MONDAY, '12:00').toISOString()],
      [local(MONDAY, '13:00').toISOString(), local(MONDAY, '17:00').toISOString()],
    ]);
  });

  it('REPLACES the weekly pattern with custom hours rather than adding to them', async () => {
    // "On the 14th I work 14:00 to 18:00" means instead of the usual Monday.
    // Added to it, the provider would be bookable 09:00-18:00 and would find
    // themselves in a consultation at 09:30 on a day they had cleared.
    const { service } = build({ rules: [weekly(1, 9, 17), customHours(MONDAY, 14, 18)] });
    const free = await service.freeIntervals(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
    );
    expect(show(free)).toEqual([
      [local(MONDAY, '14:00').toISOString(), local(MONDAY, '18:00').toISOString()],
    ]);
  });

  it('blocks a custom-hours day too, so leave is one action whatever the diary says', async () => {
    const { service } = build({ rules: [customHours(MONDAY, 14, 18), blocked(MONDAY)] });
    expect(
      await service.freeIntervals(DOCTOR, local(MONDAY, '00:00'), local(MONDAY, '23:59')),
    ).toEqual([]);
  });

  it('takes existing bookings out of the free time', async () => {
    const { service } = build({
      rules: [weekly(1, 9, 17)],
      booked: [{ startsAt: local(MONDAY, '10:00'), endsAt: local(MONDAY, '10:35') }],
    });
    const free = await service.freeIntervals(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
    );
    expect(show(free)).toEqual([
      [local(MONDAY, '09:00').toISOString(), local(MONDAY, '10:00').toISOString()],
      [local(MONDAY, '10:35').toISOString(), local(MONDAY, '17:00').toISOString()],
    ]);
  });

  it('joins a night shift that runs past midnight into one unbroken run', async () => {
    // 22:00-24:00 on Monday and 00:00-02:00 on Tuesday are the same four hours
    // at the desk. Counted as two runs, FR-10.7 would refuse a long booking at
    // 23:45 that the provider can perfectly well take.
    const { service } = build({ rules: [weekly(1, 22, 24), weekly(2, 0, 2)] });
    const free = await service.freeIntervals(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(TUESDAY, '23:59'),
    );
    expect(show(free)).toEqual([
      [local(MONDAY, '22:00').toISOString(), local(TUESDAY, '02:00').toISOString()],
    ]);
  });

  it('does not report the tail of a run as a shorter one when the lookup starts mid-shift', async () => {
    // The window opens at Tuesday midnight, in the middle of Monday's night
    // shift. The day before has to be computed for the run to be whole.
    const { service } = build({ rules: [weekly(1, 22, 24), weekly(2, 0, 2)] });
    const [remaining] = await service.remainingFor([DOCTOR], local(TUESDAY, '00:30'));
    expect(remaining.availableMinutes).toBe(90);
  });

  it('refuses a lookup wider than the module will compute', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    await expect(
      service.freeIntervals(DOCTOR, local(MONDAY, '00:00'), new Date('2027-09-14T00:00:00.000Z')),
    ).rejects.toMatchObject({ status: 400, response: { code: 'RANGE_TOO_WIDE' } });
  });

  // -- Slots ----------------------------------------------------------------

  it('lays slots out at duration plus buffer, from the start of the window', async () => {
    const { service } = build({ rules: [weekly(1, 9, 11)], durationMinutes: 30, bufferMinutes: 5 });
    const slots = await service.slotsFor(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
      local(MONDAY, '00:00'),
    );
    expect(times(slots).slice(0, 3)).toEqual([
      local(MONDAY, '09:00').toISOString(),
      local(MONDAY, '09:35').toISOString(),
      local(MONDAY, '10:10').toISOString(),
    ]);
    // 10:45 + 35 minutes runs past 11:00, so it is not offered.
    expect(times(slots)).toHaveLength(3);
  });

  it('ends a slot at the consultation, not at the end of its buffer', async () => {
    const { service } = build({ rules: [weekly(1, 9, 11)] });
    const [first] = await service.slotsFor(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
      local(MONDAY, '00:00'),
    );
    expect(first.endsAt.toISOString()).toBe(local(MONDAY, '09:30').toISOString());
  });

  it('never offers a slot that has already started', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    const slots = await service.slotsFor(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
      local(MONDAY, '13:00'),
    );
    expect(times(slots)[0]).toBe(local(MONDAY, '13:00').toISOString());
  });

  it('offers nothing on a blocked date', async () => {
    // "Blocked dates never appear as bookable" - MODULES M-07.
    const { service } = build({ rules: [weekly(1, 9, 17), blocked(MONDAY)] });
    const slots = await service.slotsFor(
      DOCTOR,
      local(MONDAY, '00:00'),
      local(MONDAY, '23:59'),
      local(MONDAY, '00:00'),
    );
    expect(slots).toEqual([]);
  });

  it('lays no slots when a window is shorter than one booking', () => {
    const free = [{ startsAt: local(MONDAY, '09:00'), endsAt: local(MONDAY, '09:30') }];
    expect(slotsIn(free, 30, 5)).toEqual([]);
  });

  // -- FR-10.7 --------------------------------------------------------------

  it('answers how long a provider is free FOR, not merely whether they are free', async () => {
    // The heart of FR-10.7. Free at 15:00, booked from 15:10: a system that
    // asked only "free at 15:00?" would assign a thirty-minute consultation
    // and have both parties discover the collision in the video room.
    const { service } = build({
      rules: [weekly(1, 9, 17)],
      booked: [{ startsAt: local(MONDAY, '15:10'), endsAt: local(MONDAY, '15:45') }],
    });
    const [remaining] = await service.remainingFor([DOCTOR], local(MONDAY, '15:00'));

    expect(remaining.availableMinutes).toBe(10);
    expect(remaining.requiredMinutes).toBe(35);
    expect(remaining.assignable).toBe(false);
  });

  it('counts the buffer as time the provider owes, not time they can sell', async () => {
    // 30 free minutes with a 30-minute consultation looks like a fit until the
    // five-minute buffer is added, which is why `requiredMinutes` is the sum.
    const { service } = build({ rules: [weekly(1, 9, 17)], durationMinutes: 30, bufferMinutes: 5 });
    const [remaining] = await service.remainingFor([DOCTOR], local(MONDAY, '16:30'));
    expect(remaining.availableMinutes).toBe(30);
    expect(remaining.assignable).toBe(false);
  });

  it('reports nothing available outside the provider’s hours', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    const [remaining] = await service.remainingFor([DOCTOR], local(MONDAY, '18:00'));
    expect(remaining.availableMinutes).toBe(0);
    expect(remaining.assignable).toBe(false);
  });

  it('will not call an unlisted provider assignable however empty their diary', async () => {
    // Verification and listing are M-05's two separate admin actions, and an
    // open diary does not substitute for either.
    const { service } = build({ rules: [weekly(1, 9, 17)], isBookable: false });
    const [remaining] = await service.remainingFor([DOCTOR], local(MONDAY, '10:00'));
    expect(remaining.availableMinutes).toBe(420);
    expect(remaining.assignable).toBe(false);
  });

  it('filters a pool down to the providers who can actually take the case', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    expect(await service.assignableAt([DOCTOR, 'doctor-2'], local(MONDAY, '10:00'))).toEqual([
      DOCTOR,
      'doctor-2',
    ]);
    expect(await service.assignableAt([DOCTOR], local(MONDAY, '20:00'))).toEqual([]);
  });

  it('filters the pool on the same inputs assignment uses (FR-18.9, FR-20.2)', async () => {
    // *** LANGUAGE IS THE ONE INPUT THAT IS NEVER RELAXED (FR-20.4). *** An
    // admin checking or overriding an allocation has to see the pool the way
    // assignment saw it; a panel that could not filter on language would offer
    // providers who cannot speak to that patient.
    const { service, listForAdmin } = build({ rules: [weekly(1, 9, 17)], pool: [] });
    await service.remainingAcrossPool(
      { specialtyId: 'specialty-1', regionId: 'region-1', language: 'hi' },
      local(MONDAY, '10:00'),
    );

    expect(listForAdmin.mock.calls[0][0]).toMatchObject({
      specialtyId: 'specialty-1',
      regionId: 'region-1',
      language: 'hi',
      verificationStatus: 'verified',
      isListed: true,
    });
  });

  it('shows the admin only verified, listed providers, longest run first', async () => {
    const { service, listForAdmin } = build({
      rules: [weekly(1, 9, 17)],
      pool: [
        { id: DOCTOR, fullName: 'Dr A' },
        { id: 'doctor-2', fullName: 'Dr B' },
      ],
    });
    const view = await service.remainingAcrossPool(
      { specialtyId: 'specialty-1' },
      local(MONDAY, '10:00'),
    );

    expect(listForAdmin.mock.calls[0][0]).toMatchObject({
      specialtyId: 'specialty-1',
      verificationStatus: 'verified',
      isListed: true,
    });
    expect(view.map((entry) => entry.fullName)).toEqual(['Dr A', 'Dr B']);
    expect(view[0].availableMinutes).toBe(420);
  });

  // -- The conflict guard ---------------------------------------------------

  it('lets a booking through when the whole of it fits', async () => {
    const { service, assertBookable } = build({ rules: [weekly(1, 9, 17)] });
    await expect(
      service.assertFree(DOCTOR, local(MONDAY, '10:00'), local(MONDAY, '08:00')),
    ).resolves.toBeUndefined();
    // Bookability is M-05's question, and it is asked every time.
    expect(assertBookable).toHaveBeenCalledWith(DOCTOR);
  });

  it('refuses a second booking on a slot that is already taken', async () => {
    // "Two patients cannot take the same slot" - MODULES M-07.
    const { service } = build({
      rules: [weekly(1, 9, 17)],
      booked: [{ startsAt: local(MONDAY, '10:00'), endsAt: local(MONDAY, '10:35') }],
    });
    await expect(
      service.assertFree(DOCTOR, local(MONDAY, '10:00'), local(MONDAY, '08:00')),
    ).rejects.toMatchObject({ status: 409, response: { code: 'SLOT_UNAVAILABLE' } });
  });

  it('refuses a booking that would overrun the end of the provider’s day', async () => {
    // 16:40 plus thirty minutes plus a five-minute buffer runs to 17:15.
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    await expect(
      service.assertFree(DOCTOR, local(MONDAY, '16:40'), local(MONDAY, '08:00')),
    ).rejects.toMatchObject({ status: 409, response: { code: 'SLOT_UNAVAILABLE' } });
  });

  it('refuses a booking that straddles a break', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17), blocked(MONDAY, 12, 13)] });
    await expect(
      service.assertFree(DOCTOR, local(MONDAY, '11:45'), local(MONDAY, '08:00')),
    ).rejects.toMatchObject({ status: 409, response: { code: 'SLOT_UNAVAILABLE' } });
  });

  it('refuses a booking in the past', async () => {
    const { service } = build({ rules: [weekly(1, 9, 17)] });
    await expect(
      service.assertFree(DOCTOR, local(MONDAY, '10:00'), local(MONDAY, '11:00')),
    ).rejects.toMatchObject({ status: 409, response: { code: 'SLOT_UNAVAILABLE' } });
  });
});

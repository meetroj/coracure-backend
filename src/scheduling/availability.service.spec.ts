import { AvailabilityRuleType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { AvailabilityService } from './availability.service';
import { timeColumnFromMinutes } from './local-time';

const DOCTOR = 'doctor-1';
const DOCTOR_ACTOR: AuthenticatedActor = { type: 'doctor', id: DOCTOR };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

/** Far enough ahead that the "not in the past" rule never fires by accident. */
const FUTURE = '2030-09-14';

type Row = Record<string, unknown>;

const row = (over: Row = {}) => ({
  id: 'rule-1',
  doctorId: DOCTOR,
  ruleType: AvailabilityRuleType.weekly,
  dayOfWeek: 1,
  specificDate: null,
  startTime: timeColumnFromMinutes(9 * 60),
  endTime: timeColumnFromMinutes(17 * 60),
  createdAt: new Date(),
  ...over,
});

function build(over: { rows?: Row[]; deleted?: number } = {}) {
  const findMany = vi
    .fn<(args: { where?: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? []);
  const deleteMany = vi
    .fn<(args: { where: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: over.deleted ?? 1 });
  // The times are written as SQL LITERALS, not through Prisma: a `time` of
  // 24:00 has no JS Date that serialises to it. So the write path under test is
  // `$queryRaw`, and this is what captures the values it was given.
  const queryRaw = vi
    .fn<(strings: TemplateStringsArray, ...values: (string | number | null)[]) => Promise<Row[]>>()
    .mockImplementation((_strings, ...values) =>
      Promise.resolve([
        row({
          id: 'rule-new',
          doctorId: values[0],
          ruleType: values[1],
          dayOfWeek: values[2],
          specificDate: values[3] === null ? null : new Date(`${values[3]}T00:00:00.000Z`),
          startTime: values[4],
          endTime: values[5],
        }),
      ]),
    );
  const transaction = vi
    .fn<(work: (client: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation((work) =>
      work({ doctorAvailability: { deleteMany }, $queryRaw: queryRaw }),
    );

  const prisma = {
    doctorAvailability: { findMany, deleteMany },
    $transaction: transaction,
    $queryRaw: queryRaw,
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const getAccount = vi.fn<(doctorId: string) => Promise<Row>>().mockResolvedValue({
    id: DOCTOR,
    consultationDurationMinutes: 30,
    bufferMinutes: 5,
  });

  return {
    service: new AvailabilityService(
      prisma,
      { record } as unknown as AuditService,
      { getAccount } as unknown as DoctorRegistryService,
    ),
    findMany,
    deleteMany,
    transaction,
    queryRaw,
    record,
    getAccount,
  };
}

describe('AvailabilityService', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      PLATFORM_TIMEZONE: 'Asia/Kolkata',
    });
  });

  // -- Reads ----------------------------------------------------------------

  it('reads a diary back as local HH:MM, with the zone it is written in', async () => {
    // The client must render these in the platform zone, not the device one:
    // a provider travelling would otherwise see their own hours move.
    const { service } = build({ rows: [row()] });
    const diary = await service.diaryOf(DOCTOR);

    expect(diary.timeZone).toBe('Asia/Kolkata');
    expect(diary.weekly).toEqual([
      {
        id: 'rule-1',
        dayOfWeek: 1,
        date: null,
        startTime: '09:00',
        endTime: '17:00',
        channels: ['video', 'audio'],
      },
    ]);
    expect(diary.consultationDurationMinutes).toBe(30);
    expect(diary.bufferMinutes).toBe(5);
  });

  it('splits a diary by rule type so each one reads as what it is', async () => {
    const { service } = build({
      rows: [
        row(),
        row({
          id: 'rule-2',
          ruleType: AvailabilityRuleType.blocked,
          dayOfWeek: null,
          specificDate: new Date('2030-09-14T00:00:00.000Z'),
          startTime: null,
          endTime: null,
        }),
      ],
    });
    const diary = await service.diaryOf(DOCTOR);

    expect(diary.weekly).toHaveLength(1);
    // No times: a whole day of leave.
    expect(diary.blocked).toEqual([
      {
        id: 'rule-2',
        dayOfWeek: null,
        date: '2030-09-14',
        startTime: null,
        endTime: null,
        channels: ['video', 'audio'],
      },
    ]);
  });

  it('returns an empty list for a provider with no rules, not an absent key', async () => {
    const { service } = build({ rows: [] });
    expect(await service.rulesFor([DOCTOR])).toEqual(new Map([[DOCTOR, []]]));
  });

  // -- The weekly pattern ---------------------------------------------------

  it('replaces the weekly pattern in one transaction rather than adding to it', async () => {
    // Delete and insert have to be atomic: between them the provider has no
    // pattern at all, and a booking landing there would find an empty diary.
    const { service, transaction, deleteMany, queryRaw } = build();
    await service.replaceWeekly(
      DOCTOR,
      [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
      DOCTOR_ACTOR,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      doctorId: DOCTOR,
      ruleType: AvailabilityRuleType.weekly,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('lets an empty pattern clear the diary', async () => {
    const { service, queryRaw } = build();
    await service.replaceWeekly(DOCTOR, [], DOCTOR_ACTOR);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses two windows that overlap on the same weekday', async () => {
    // 9-13 and 11-17 is almost always an edit that went wrong. Saved as their
    // union it would look accepted and mean something the provider did not say.
    const { service, transaction } = build();
    await expect(
      service.replaceWeekly(
        DOCTOR,
        [
          { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
          { dayOfWeek: 1, startTime: '11:00', endTime: '17:00' },
        ],
        DOCTOR_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: 'OVERLAPPING_AVAILABILITY' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('allows the same hours on two different weekdays', async () => {
    const { service, queryRaw } = build();
    await service.replaceWeekly(
      DOCTOR,
      [
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
      ],
      DOCTOR_ACTOR,
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('allows two windows on one day with a gap between them', async () => {
    const { service, queryRaw } = build();
    await service.replaceWeekly(
      DOCTOR,
      [
        { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
        { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
      ],
      DOCTOR_ACTOR,
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('refuses a window that does not move forwards', async () => {
    const { service } = build();
    await expect(
      service.replaceWeekly(
        DOCTOR,
        [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }],
        DOCTOR_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'INVALID_TIME_RANGE' } });
  });

  it('refuses a window of no length', async () => {
    const { service } = build();
    await expect(
      service.replaceWeekly(
        DOCTOR,
        [{ dayOfWeek: 1, startTime: '09:00', endTime: '09:00' }],
        DOCTOR_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'INVALID_TIME_RANGE' } });
  });

  it('writes a window running to midnight as the LITERAL 24:00', async () => {
    // *** THE ONE PRISMA CANNOT WRITE. *** A JS Date carries only a time of
    // day, so 1440 minutes serialises to `00:00:00` and trips the
    // `start < end` CHECK. Written as a literal it stays 24:00, which is what
    // lets a night shift MEET the next day's 00:00 window rather than leave a
    // one-minute gap that would split an unbroken run in two.
    const { service, queryRaw } = build();
    await service.replaceWeekly(
      DOCTOR,
      [{ dayOfWeek: 1, startTime: '22:00', endTime: '24:00' }],
      DOCTOR_ACTOR,
    );
    const values = queryRaw.mock.calls[0].slice(1);
    expect(values[4]).toBe('22:00');
    expect(values[5]).toBe('24:00');
  });

  // -- Blocks and overrides -------------------------------------------------

  it('blocks a whole day when no times are given', async () => {
    const { service, queryRaw } = build();
    const created = await service.block(DOCTOR, { date: FUTURE }, DOCTOR_ACTOR);

    const values = queryRaw.mock.calls[0].slice(1);
    expect(values[1]).toBe(AvailabilityRuleType.blocked);
    expect(values[4]).toBeNull();
    expect(values[5]).toBeNull();
    expect(created.startTime).toBeNull();
  });

  it('blocks part of a day when both times are given', async () => {
    const { service, queryRaw } = build();
    await service.block(DOCTOR, { date: FUTURE, startTime: '13:00', endTime: '15:00' }, ADMIN);
    expect(queryRaw.mock.calls[0].slice(1)[4]).toBe('13:00');
  });

  it('refuses a block with only one of the two times', async () => {
    // Half a window is not a shorter block, it is an ambiguous one: it could
    // mean "from 13:00" or "until 13:00", and guessing either could leave a
    // provider bookable on an afternoon they meant to clear.
    const { service } = build();
    await expect(
      service.block(DOCTOR, { date: FUTURE, startTime: '13:00' }, DOCTOR_ACTOR),
    ).rejects.toMatchObject({ status: 400, response: { code: 'INVALID_TIME_RANGE' } });
  });

  it('allows two blocks that overlap', async () => {
    // Unlike availability, taking the same time away twice is well defined,
    // and refusing it would only make an admin hunt for the earlier block.
    const { service, queryRaw } = build({
      rows: [
        row({
          ruleType: AvailabilityRuleType.blocked,
          startTime: timeColumnFromMinutes(12 * 60),
          endTime: timeColumnFromMinutes(14 * 60),
        }),
      ],
    });
    await service.block(DOCTOR, { date: FUTURE, startTime: '13:00', endTime: '15:00' }, ADMIN);
    expect(queryRaw).toHaveBeenCalled();
  });

  it('refuses custom hours that overlap another override on the same date', async () => {
    const { service, queryRaw } = build({
      rows: [
        row({
          ruleType: AvailabilityRuleType.custom_hours,
          startTime: timeColumnFromMinutes(14 * 60),
          endTime: timeColumnFromMinutes(18 * 60),
        }),
      ],
    });
    await expect(
      service.setCustomHours(
        DOCTOR,
        { date: FUTURE, startTime: '16:00', endTime: '20:00' },
        DOCTOR_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: 'OVERLAPPING_AVAILABILITY' } });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses leave on a date that has already gone', async () => {
    // It would change nothing about who can be booked, so accepting it would
    // only fill the diary with rows that mean nothing.
    const { service } = build();
    await expect(service.block(DOCTOR, { date: '2020-01-01' }, DOCTOR_ACTOR)).rejects.toMatchObject(
      { status: 400, response: { code: 'DATE_IN_THE_PAST' } },
    );
  });

  it('404s a diary edit for a provider that does not exist', async () => {
    const { service, getAccount } = build();
    getAccount.mockRejectedValue(
      Object.assign(new Error('nope'), { response: { code: 'DOCTOR_NOT_FOUND' } }),
    );
    await expect(service.diaryOf('nobody')).rejects.toMatchObject({
      response: { code: 'DOCTOR_NOT_FOUND' },
    });
  });

  // -- Removal and the trail ------------------------------------------------

  it('deletes a rule rather than deactivating it', async () => {
    const { service, deleteMany } = build({ deleted: 1 });
    await service.removeRule(DOCTOR, 'rule-1', DOCTOR_ACTOR);
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: 'rule-1', doctorId: DOCTOR });
  });

  it('will not let one provider delete a rule from another diary', async () => {
    // Scoped by doctorId, so an id from somebody else's diary reads as absent
    // rather than as a permission error that confirms it exists.
    const { service } = build({ deleted: 0 });
    await expect(service.removeRule(DOCTOR, 'rule-9', DOCTOR_ACTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'AVAILABILITY_RULE_NOT_FOUND' },
    });
  });

  it('names whose diary an admin changed, as well as which admin', async () => {
    // An admin edit and a provider's own edit write the same row, so the entry
    // has to carry both or the trail cannot answer "who cleared my Friday".
    const { service, record } = build();
    await service.block(DOCTOR, { date: FUTURE }, ADMIN);

    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'create',
      entityType: 'doctor_availability',
      metadata: { doctorId: DOCTOR, rule: 'blocked', wholeDay: true },
    });
  });
});

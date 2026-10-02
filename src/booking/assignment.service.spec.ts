import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AllocationPolicy, AllocationPolicyService } from '../catalogue/allocation-policy.service';
import { PrismaService } from '../database/prisma.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { RemainingAvailability, SchedulingService } from '../scheduling/scheduling.service';
import { AssignmentService } from './assignment.service';

const AT = new Date('2026-09-14T09:30:00.000Z');

type Doctor = { id: string; fullName: string };

const POLICY: AllocationPolicy = {
  regionRelaxable: true, 
  tieBreak: 'fewest_upcoming',
  maxPatientDeclines: 2,
};

interface Setup {
  /** Keyed by the filter used: 'region' for the in-region pool, 'any' for all. */
  inRegion?: Doctor[];
  anywhere?: Doctor[];
  /** Who is actually free for long enough, by id. */
  free?: string[];
  availableMinutes?: Record<string, number>;
  upcoming?: Record<string, number>;
  lastAssigned?: Record<string, string>;
  policy?: Partial<AllocationPolicy>;
  soonest?: Date | null;
  durations?: Record<string, number>;
}

function build(over: Setup = {}) {
  const anywhere = over.anywhere ?? [];
  const inRegion = over.inRegion ?? [];

  const listForAdmin = vi
    .fn<(filter: Record<string, unknown>) => Promise<Doctor[]>>()
    .mockImplementation((filter) => Promise.resolve(filter.regionId ? inRegion : anywhere));
  const bookingProfilesOf = vi
    .fn<(ids: string[]) => Promise<Map<string, { consultationDurationMinutes: number }>>>()
    .mockImplementation((ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { consultationDurationMinutes: over.durations?.[id] ?? 30 }])),
      ),
    );
  const doctors = { listForAdmin, bookingProfilesOf } as unknown as DoctorRegistryService;

  const freeSet = new Set(over.free ?? anywhere.map((d) => d.id));
  const remainingFor = vi
    .fn<(ids: string[], at: Date) => Promise<RemainingAvailability[]>>()
    .mockImplementation((ids) =>
      Promise.resolve(
        ids.map((id) => ({
          doctorId: id,
          availableMinutes: over.availableMinutes?.[id] ?? 120,
          requiredMinutes: 35,
          assignable: freeSet.has(id),
        })),
      ),
    );
  const soonestForPool = vi
    .fn<(filter: Record<string, unknown>, from: Date) => Promise<Date | null>>()
    .mockResolvedValue(
      over.soonest === undefined ? new Date('2026-09-15T09:00:00.000Z') : over.soonest,
    );
  const scheduling = { remainingFor, soonestForPool } as unknown as SchedulingService;

  const current = vi
    .fn<() => Promise<AllocationPolicy>>()
    .mockResolvedValue({ ...POLICY, ...over.policy });
  const policy = { current } as unknown as AllocationPolicyService;

  const groupBy = vi
    .fn<
      (args: {
        _count?: unknown;
        _max?: unknown;
        where: { doctorId: { in: string[] } };
      }) => Promise<unknown[]>
    >()
    .mockImplementation((args) => {
      const ids = args.where.doctorId.in;
      if (args._max) {
        return Promise.resolve(
          ids.map((id) => ({
            doctorId: id,
            _max: { createdAt: over.lastAssigned?.[id] ? new Date(over.lastAssigned[id]) : null },
          })),
        );
      }
      return Promise.resolve(
        ids.map((id) => ({ doctorId: id, _count: { _all: over.upcoming?.[id] ?? 0 } })),
      );
    });
  const prisma = { consultation: { groupBy } } as unknown as PrismaService;

  const record = vi
    .fn<(entry: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue(undefined);

  return {
    soonestForPool,
    service: new AssignmentService(prisma, doctors, scheduling, policy, {
      record,
    } as unknown as AuditService),
    listForAdmin,
    record,
  };
}

const request = (over: Record<string, unknown> = {}) => ({
  specialtyId: 'psychiatry',
  language: 'hi',
  regionId: 'karnataka',
  at: AT,
  ...over,
});

describe('AssignmentService — the four inputs (FR-20.2)', () => {
  it('filters on specialty and language together', async () => {
    const { service, listForAdmin } = build({ anywhere: [{ id: 'd1', fullName: 'A' }] });
    await service.resolve(request({ regionId: null }));

    expect(listForAdmin.mock.calls[0][0]).toMatchObject({
      specialtyId: 'psychiatry',
      language: 'hi',
      verificationStatus: 'verified',
      isListed: true,
    });
  });

  it('*** NEVER relaxes language ***, on any branch (FR-20.4)', async () => {
    // The one rule with no policy setting behind it. Every pool query this
    // service makes must carry the language, including the relaxed-region one.
    const { service, listForAdmin } = build({
      inRegion: [],
      anywhere: [{ id: 'd1', fullName: 'A' }],
      free: ['d1'],
    });
    const result = await service.resolve(request());

    expect(result.assigned).toBe(true);
    for (const call of listForAdmin.mock.calls) {
      expect(call[0]).toMatchObject({ language: 'hi' });
    }
  });

  it('requires BOTH verified and listed (FR-20.3)', async () => {
    const { service, listForAdmin } = build({ anywhere: [{ id: 'd1', fullName: 'A' }] });
    await service.resolve(request());
    expect(listForAdmin.mock.calls[0][0]).toMatchObject({
      verificationStatus: 'verified',
      isListed: true,
    });
  });

  it('refuses when nobody speaks the language, without looking at diaries', async () => {
    const { service } = build({ anywhere: [] });
    const result = await service.resolve(request());

    expect(result).toMatchObject({
      assigned: false,
      reason: 'no_provider_speaks_the_language',
    });
  });

  it('excludes a provider free at the time but not free for LONG ENOUGH (FR-10.7)', async () => {
    const { service } = build({
      inRegion: [{ id: 'busy', fullName: 'Busy' }],
      anywhere: [{ id: 'busy', fullName: 'Busy' }],
      free: [],
    });
    const result = await service.resolve(request());
    expect(result).toMatchObject({ assigned: false, reason: 'none_free_for_long_enough' });
  });
});

describe('AssignmentService — region is a preference (FR-20.5)', () => {
  it('prefers a provider in the patient’s region', async () => {
    const { service } = build({
      inRegion: [{ id: 'local', fullName: 'Local' }],
      anywhere: [
        { id: 'local', fullName: 'Local' },
        { id: 'far', fullName: 'Far' },
      ],
      free: ['local', 'far'],
    });
    const result = await service.resolve(request());

    expect(result).toMatchObject({ assigned: true, doctorId: 'local' });
    if (result.assigned) expect(result.matchedOn.regionRelaxed).toBe(false);
  });

  it('goes outside the region when nobody in it is free, and RECORDS that it did', async () => {
    // A patient is never left unable to book because their region's pool is thin.
    const { service } = build({
      inRegion: [{ id: 'local', fullName: 'Local' }],
      anywhere: [
        { id: 'local', fullName: 'Local' },
        { id: 'far', fullName: 'Far' },
      ],
      free: ['far'],
    });
    const result = await service.resolve(request());

    expect(result).toMatchObject({ assigned: true, doctorId: 'far' });
    if (result.assigned) expect(result.matchedOn.regionRelaxed).toBe(true);
  });

  it('stays inside the region when the policy forbids relaxing it', async () => {
    const { service } = build({
      inRegion: [{ id: 'local', fullName: 'Local' }],
      anywhere: [
        { id: 'local', fullName: 'Local' },
        { id: 'far', fullName: 'Far' },
      ],
      free: ['far'],
      policy: { regionRelaxable: false },
    });
    expect(await service.resolve(request())).toMatchObject({ assigned: false });
  });

  it('uses the whole pool when the patient has no region set', async () => {
    const { service } = build({
      anywhere: [{ id: 'anyone', fullName: 'Anyone' }],
      free: ['anyone'],
    });
    const result = await service.resolve(request({ regionId: null }));
    expect(result).toMatchObject({ assigned: true, doctorId: 'anyone' });
  });
});

describe('AssignmentService — breaking a tie (FR-20.6)', () => {
  const three = [
    { id: 'a', fullName: 'A' },
    { id: 'b', fullName: 'B' },
    { id: 'c', fullName: 'C' },
  ];

  it('spreads work across the pool by default', async () => {
    // `fewest_upcoming` is the load-balancing default: work spreads rather than
    // landing on whoever sorts first.
    const { service } = build({
      inRegion: three,
      anywhere: three,
      free: ['a', 'b', 'c'],
      upcoming: { a: 5, b: 1, c: 9 },
    });
    expect(await service.resolve(request())).toMatchObject({ doctorId: 'b' });
  });

  it('can pick the provider with the longest free run', async () => {
    const { service } = build({
      inRegion: three,
      anywhere: three,
      free: ['a', 'b', 'c'],
      availableMinutes: { a: 60, b: 45, c: 300 },
      policy: { tieBreak: 'longest_free' },
    });
    expect(await service.resolve(request())).toMatchObject({ doctorId: 'c' });
  });

  it('can pick whoever was assigned least recently', async () => {
    const { service } = build({
      inRegion: three,
      anywhere: three,
      free: ['a', 'b', 'c'],
      lastAssigned: {
        a: '2026-09-10T00:00:00.000Z',
        b: '2026-09-01T00:00:00.000Z',
        c: '2026-09-12T00:00:00.000Z',
      },
      policy: { tieBreak: 'least_recently_assigned' },
    });
    expect(await service.resolve(request())).toMatchObject({ doctorId: 'b' });
  });

  it('gives a never-assigned provider work rather than making them wait', async () => {
    const { service } = build({
      inRegion: three,
      anywhere: three,
      free: ['a', 'b', 'c'],
      lastAssigned: { a: '2026-09-10T00:00:00.000Z', c: '2026-09-12T00:00:00.000Z' },
      policy: { tieBreak: 'least_recently_assigned' },
    });
    expect(await service.resolve(request())).toMatchObject({ doctorId: 'b' });
  });

  it('is deterministic when the policy cannot separate two providers', async () => {
    const { service } = build({
      inRegion: three,
      anywhere: three,
      free: ['a', 'b'],
      upcoming: { a: 2, b: 2 },
    });
    expect(await service.resolve(request())).toMatchObject({ doctorId: 'a' });
  });
});

describe('AssignmentService — declines and refusals', () => {
  it('skips a provider the patient has already declined (FR-4.4)', async () => {
    const pair = [
      { id: 'first', fullName: 'First' },
      { id: 'second', fullName: 'Second' },
    ];
    const { service } = build({ inRegion: pair, anywhere: pair, free: ['first', 'second'] });
    const result = await service.resolve(request({ excludeDoctorIds: ['first'] }));
    expect(result).toMatchObject({ assigned: true, doctorId: 'second' });
  });

  it('tells "all declined" apart from "nobody free", because the fix differs', async () => {
    const one = [{ id: 'only', fullName: 'Only' }];
    const { service } = build({ inRegion: one, anywhere: one, free: ['only'] });
    const result = await service.resolve(request({ excludeDoctorIds: ['only'] }));
    expect(result).toMatchObject({ assigned: false, reason: 'all_declined' });
  });

  it('asks for the soonest time IN THE PATIENT’S LANGUAGE', async () => {
    // A time only a provider who cannot speak to them is free at is not a time
    // that covers them; offering it sends the patient back to the same refusal.
    const one = [{ id: 'busy', fullName: 'Busy' }];
    const { service, soonestForPool } = build({ inRegion: one, anywhere: one, free: [] });
    await service.resolve(request());
    expect(soonestForPool.mock.calls[0][0]).toMatchObject({ language: 'hi' });
  });

  it('offers the next time the pool CAN cover it (FR-20.7)', async () => {
    // Never a fallback to somebody who does not match - a refusal that names a
    // time is the only acceptable answer.
    const soon = new Date('2026-09-15T09:00:00.000Z');
    const one = [{ id: 'busy', fullName: 'Busy' }];
    const { service } = build({ inRegion: one, anywhere: one, free: [], soonest: soon });
    const result = await service.resolve(request());
    expect(result).toMatchObject({ assigned: false, soonestAvailableAt: soon });
  });
});

describe('AssignmentService — why this provider (FR-20.9)', () => {
  it('writes what it matched on to the audit log, not to a column', async () => {
    const one = [{ id: 'chosen', fullName: 'Chosen' }];
    const { service, record } = build({
      inRegion: one,
      anywhere: one,
      free: ['chosen'],
      availableMinutes: { chosen: 240 },
    });
    const outcome = await service.resolve(request());
    await service.recordDecision('consult-1', 'patient-1', outcome);

    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'system',
      entityType: 'consultation_assignment',
      consultationId: 'consult-1',
      metadata: {
        assignedDoctorId: 'chosen',
        language: 'hi',
        regionRelaxed: false,
        tieBreak: 'fewest_upcoming',
        availableMinutes: 240,
      },
    });
  });

  it('records a REFUSAL too, because an empty pool leaves no other trace', async () => {
    // No consultation is created, so without this the client never learns that
    // demand arrived and could not be met.
    const { service, record } = build({ anywhere: [] });
    const outcome = await service.resolve(request());
    await service.recordDecision(null, 'patient-1', outcome);

    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'consultation_assignment',
      entityId: 'patient-1',
      metadata: { refused: true, reason: 'no_provider_speaks_the_language' },
    });
  });

  it('carries the chosen provider’s own consultation length', async () => {
    const one = [{ id: 'long', fullName: 'Long' }];
    const { service } = build({
      inRegion: one,
      anywhere: one,
      free: ['long'],
      durations: { long: 50 },
    });
    expect(await service.resolve(request())).toMatchObject({ durationMinutes: 50 });
  });
});

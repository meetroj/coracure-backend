import { ConsultationStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../database/prisma.service';
import {
  ConsultationBackedAccess,
  ConsultationBookedIntervals,
  ConsultationDoctorMetrics,
} from './booking.adapters';

type Row = Record<string, unknown>;

function build(
  over: {
    rows?: Row[];
    doctors?: Row[];
    found?: Row | null;
    counts?: number[];
    /** offered, then accepted. */
    instantCounts?: number[];
    /** Completed consultations whose record was finalised. */
    summarised?: number;
  } = {},
) {
  const counts = [...(over.counts ?? [])];
  const instantCounts = [...(over.instantCounts ?? [])];
  const consultationFindMany = vi
    .fn<(args: { where: Row; select?: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? []);
  const consultationFindUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? null : over.found);
  const consultationCount = vi
    .fn<(args: { where: Row }) => Promise<number>>()
    .mockImplementation(() => Promise.resolve(counts.shift() ?? 0));
  const doctorFindMany = vi
    .fn<() => Promise<Row[]>>()
    .mockResolvedValue(over.doctors ?? [{ id: 'doctor-1', bufferMinutes: 5 }]);

  // The reliability figures count across three tables now: M-11's
  // consultations, M-13's instant offers and M-15's clinical records. Separate
  // queues, so a test can set one rate without disturbing another.
  const instantCount = vi
    .fn<(args: { where: Row }) => Promise<number>>()
    .mockImplementation(() => Promise.resolve(instantCounts.shift() ?? 0));
  const recordCount = vi
    .fn<(args: { where: Row }) => Promise<number>>()
    .mockImplementation(() => Promise.resolve(over.summarised ?? 0));

  const prisma = {
    consultation: {
      findMany: consultationFindMany,
      findUnique: consultationFindUnique,
      count: consultationCount,
    },
    doctor: { findMany: doctorFindMany },
    instantConsultancy: { count: instantCount },
    clinicalRecord: { count: recordCount },
  } as unknown as PrismaService;

  return {
    prisma,
    consultationFindMany,
    consultationCount,
    instantCount,
    recordCount,
    intervals: new ConsultationBookedIntervals(prisma),
    access: new ConsultationBackedAccess(prisma),
    metrics: new ConsultationDoctorMetrics(prisma),
  };
}

const FROM = new Date('2026-09-14T00:00:00.000Z');
const TO = new Date('2026-09-15T00:00:00.000Z');

describe('ConsultationBookedIntervals — closing M-07’s port', () => {
  it('occupies the consultation AND its buffer', async () => {
    // A 30-minute consultation with a 5-minute buffer takes 35 minutes off the
    // diary: the buffer is time the provider is not available to anyone else.
    const { intervals } = build({
      rows: [
        {
          doctorId: 'doctor-1',
          scheduledStartAt: new Date('2026-09-14T10:00:00.000Z'),
          durationMinutes: 30,
        },
      ],
    });
    const busy = await intervals.forDoctors(['doctor-1'], FROM, TO);
    expect(busy.get('doctor-1')).toEqual([
      {
        startsAt: new Date('2026-09-14T10:00:00.000Z'),
        endsAt: new Date('2026-09-14T10:35:00.000Z'),
      },
    ]);
  });

  it('counts only the statuses that actually hold time', async () => {
    // A cancelled or expired booking must free its slot at once - that is the
    // whole point of releasing an abandoned checkout.
    const { intervals, consultationFindMany } = build();
    await intervals.forDoctors(['doctor-1'], FROM, TO);
    expect(consultationFindMany.mock.calls[0][0].where).toMatchObject({
      status: {
        in: [
          ConsultationStatus.pending_payment,
          ConsultationStatus.scheduled,
          ConsultationStatus.awaiting_doctor,
          ConsultationStatus.in_progress,
        ],
      },
    });
  });

  it('returns an empty list for a provider with nothing booked, not an absent key', async () => {
    const { intervals } = build({ rows: [] });
    expect(await intervals.forDoctors(['doctor-1'], FROM, TO)).toEqual(new Map([['doctor-1', []]]));
  });

  it('asks nothing at all for an empty pool', async () => {
    const { intervals, consultationFindMany } = build();
    expect(await intervals.forDoctors([], FROM, TO)).toEqual(new Map());
    expect(consultationFindMany).not.toHaveBeenCalled();
  });

  it('looks back far enough to catch a booking that runs into the window', async () => {
    const { intervals, consultationFindMany } = build();
    await intervals.forDoctors(['doctor-1'], FROM, TO);
    const where = consultationFindMany.mock.calls[0][0].where as {
      scheduledStartAt: { gte: Date };
    };
    expect(where.scheduledStartAt.gte.getTime()).toBeLessThan(FROM.getTime());
  });
});

describe('ConsultationBackedAccess — closing M-04’s and M-10’s ports', () => {
  it('says a doctor is treating a patient they have a consultation with', async () => {
    const { access } = build({ counts: [1] });
    expect(await access.isTreating('doctor-1', 'patient-1')).toBe(true);
  });

  it('answers M-04 in its own words, with the same rule', async () => {
    const { access } = build({ counts: [1] });
    expect(await access.isDoctorTreating('doctor-1', 'patient-1')).toBe(true);
  });

  it('does not count a cancelled booking as a course of care', async () => {
    // Otherwise booking and immediately cancelling would be a way to reach any
    // patient's record.
    const { access, consultationCount } = build({ counts: [0] });
    await access.isTreating('doctor-1', 'patient-1');
    expect(consultationCount.mock.calls[0][0].where).toMatchObject({
      status: { notIn: [ConsultationStatus.cancelled, ConsultationStatus.expired] },
    });
  });

  it('resolves a consultation into the three facts M-10 needs', async () => {
    const { access } = build({
      found: {
        id: 'consult-1',
        patientId: 'patient-1',
        doctorId: 'doctor-1',
        status: ConsultationStatus.scheduled,
      },
    });
    expect(await access.contextOf('consult-1')).toEqual({
      id: 'consult-1',
      patientId: 'patient-1',
      doctorId: 'doctor-1',
      isCompleted: false,
    });
  });

  it.each([
    ConsultationStatus.completed,
    ConsultationStatus.awaiting_documentation,
    ConsultationStatus.no_show,
  ])('treats %s as settled, so a file cannot be deleted out from under it', async (status) => {
    const { access } = build({
      found: { id: 'c', patientId: 'p', doctorId: 'd', status },
    });
    expect((await access.contextOf('c'))?.isCompleted).toBe(true);
  });

  it('is null for a consultation that does not exist', async () => {
    const { access } = build({ found: null });
    expect(await access.contextOf('nope')).toBeNull();
  });
});

describe('ConsultationDoctorMetrics — closing M-05’s port', () => {
  it('counts, rather than reading a stored counter', async () => {
    // completed, no_show, attended
    const { metrics } = build({ counts: [8, 2, 10] });
    const reliability = await metrics.reliabilityOf('doctor-1');

    expect(reliability.consultationsCompleted).toBe(8);
    expect(reliability.noShowRate).toBeCloseTo(0.2);
  });

  it('reports an unknown rate as null, never as zero', async () => {
    // A provider who has been offered nothing has not failed to accept
    // anything, and 0% on a dashboard reads as a bad doctor.
    const { metrics } = build({ counts: [0, 0, 0] });
    const reliability = await metrics.reliabilityOf('new-doctor');

    expect(reliability.noShowRate).toBeNull();
    expect(reliability.acceptanceRate).toBeNull();
    expect(reliability.caseSummaryCompletion).toBeNull();
  });

  it('measures no-shows against consultations that REACHED the appointment', async () => {
    // One cancelled a week ahead says nothing about whether a provider turns up.
    const { metrics, consultationCount } = build({ counts: [5, 1, 6] });
    await metrics.reliabilityOf('doctor-1');

    expect(consultationCount.mock.calls[2][0].where).toMatchObject({
      status: {
        in: [
          ConsultationStatus.completed,
          ConsultationStatus.no_show,
          ConsultationStatus.awaiting_documentation,
        ],
      },
    });
  });
});

/**
 * *** THE TWO RATES THAT WERE NULL UNTIL M-13 AND M-15 EXISTED. ***
 *
 * FR-18.6's figures are read as evidence about a NAMED CLINICIAN, so the
 * denominators matter as much as the arithmetic.
 */
describe('ConsultationDoctorMetrics — the rates that were waiting on later modules', () => {
  it('counts acceptance out of the offers that were actually decided', async () => {
    const { metrics } = build({ counts: [8, 2, 10], instantCounts: [10, 7] });
    const reliability = await metrics.reliabilityOf('doctor-1');
    expect(reliability.acceptanceRate).toBeCloseTo(0.7);
  });

  /**
   * *** `superseded` IS NOT A DECLINE. ***
   *
   * A provider who was still deciding when somebody else accepted first did not
   * refuse. Counting it against them would penalise being on a busy rota and
   * make the fastest tapper look like the most reliable clinician.
   */
  it('excludes offers somebody else accepted first', async () => {
    const { metrics, instantCount } = build({ counts: [1, 0, 1], instantCounts: [4, 3] });
    await metrics.reliabilityOf('doctor-1');

    const denominator = instantCount.mock.calls[0][0].where as {
      outcome: { in: string[] };
    };
    expect(denominator.outcome.in).toEqual(['accepted', 'declined', 'timed_out']);
    expect(denominator.outcome.in).not.toContain('superseded');
    expect(denominator.outcome.in).not.toContain('pending');
  });

  /** A draft is not a case summary — which is the point of M-15's freeze. */
  it('counts only FINALISED records towards summary completion', async () => {
    const { metrics, recordCount } = build({ counts: [10, 0, 10], summarised: 9 });
    const reliability = await metrics.reliabilityOf('doctor-1');

    expect(reliability.caseSummaryCompletion).toBeCloseTo(0.9);
    expect(recordCount.mock.calls[0][0].where).toMatchObject({
      finalisedAt: { not: null },
      consultation: { doctorId: 'doctor-1', status: 'completed' },
    });
  });

  /**
   * Out of COMPLETED consultations only. One still awaiting documentation is
   * not late paperwork — the doctor may be writing it now, and counting it as a
   * miss would make the figure worse the busier the clinic is.
   */
  it('does not count a consultation still awaiting documentation as a miss', async () => {
    // 4 completed, 0 no-show, 9 reached the appointment: five are still being
    // written up. All four completed ones are summarised, so this is 100%.
    const { metrics } = build({ counts: [4, 0, 9], summarised: 4 });
    const reliability = await metrics.reliabilityOf('doctor-1');
    expect(reliability.caseSummaryCompletion).toBe(1);
  });

  it('still reports null where a denominator is empty', async () => {
    const { metrics } = build({ counts: [0, 0, 0], instantCounts: [0, 0], summarised: 0 });
    const reliability = await metrics.reliabilityOf('new-doctor');
    expect(reliability.acceptanceRate).toBeNull();
    expect(reliability.caseSummaryCompletion).toBeNull();
  });
});

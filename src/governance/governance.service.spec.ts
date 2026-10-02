import { describe, expect, it, vi } from 'vitest';

import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { GovernanceService } from './governance.service';

type Row = Record<string, unknown>;

const OPERATIONS: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };
const GOVERNANCE: AuthenticatedActor = {
  type: 'admin',
  id: 'admin-2',
  level: 'clinical_governance',
};
const COORDINATOR: AuthenticatedActor = { type: 'admin', id: 'admin-3', level: 'care_coordinator' };
const CONTENT: AuthenticatedActor = { type: 'admin', id: 'admin-4', level: 'content' };

function build(over: { counts?: number[]; rows?: Row[]; doctors?: Row[]; audit?: Row[] } = {}) {
  const counts = [...(over.counts ?? [])];
  const count = vi
    .fn<(args?: Row) => Promise<number>>()
    .mockImplementation(() => Promise.resolve(counts.length > 0 ? (counts.shift() as number) : 0));

  const consultationFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? []);
  const doctorFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(over.doctors ?? [{ id: 'doctor-1', fullName: 'Dr Rao' }]);
  const auditFindMany = vi.fn<(args: Row) => Promise<Row[]>>().mockResolvedValue(over.audit ?? []);
  const complaintFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([]);
  const alertFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([]);

  const prisma = {
    consultation: { count, findMany: consultationFindMany },
    safetyAlert: { count, findMany: alertFindMany },
    checkinResponse: { count },
    complaint: { count, findMany: complaintFindMany },
    clarificationCase: { count },
    doctor: { findMany: doctorFindMany },
    auditLog: { findMany: auditFindMany },
  } as unknown as PrismaService;

  const reliabilityOf = vi.fn<() => Promise<Row>>().mockResolvedValue({
    acceptanceRate: 0.8,
    noShowRate: 0.05,
    caseSummaryCompletion: 0.95,
    consultationsCompleted: 40,
  });

  return {
    service: new GovernanceService(prisma, {
      reliabilityOf,
    } as unknown as DoctorRegistryService),
    count,
    consultationFindMany,
    auditFindMany,
    reliabilityOf,
  };
}

/**
 * *** M-20 OWNS NOTHING, AND THAT IS THE DESIGN. ***
 *
 * Its completion criterion is that every dashboard number reconciles with the
 * owning module's data. The only way to guarantee that is to have no numbers of
 * its own — no counters, no nightly rollup, no summary table. A figure cannot
 * disagree with its source because it IS its source.
 */
describe('GovernanceService — the dashboard (FR-18.6)', () => {
  it('counts rather than reading anything stored', async () => {
    const { service, count } = build({
      counts: [10, 2, 1, 3, 4, 5, 6, 15, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7],
    });
    const dashboard = await service.dashboard(OPERATIONS);

    expect(dashboard.consultations.completed).toBe(10);
    expect(dashboard.safety.openRedFlags).toBe(4);
    // Eighteen independent counts, all against tables other modules own.
    expect(count).toHaveBeenCalledTimes(18);
  });

  /**
   * An unclosed red flag from last month is still somebody's problem today, and
   * a queue that hides it behind a date filter is a queue that loses people.
   */
  it('counts OPEN safety alerts regardless of the date window', async () => {
    const { service, count } = build({ counts: Array(18).fill(1) });
    await service.dashboard(OPERATIONS, { from: new Date('2026-09-01') });

    const alertCall = count.mock.calls[4]?.[0] as { where: Record<string, unknown> };
    expect(alertCall.where).toMatchObject({ closedAt: null });
    expect(alertCall.where).not.toHaveProperty('createdAt');
  });

  /** Two figures on one screen must not come from two different moments. */
  it('counts everything against the same instant', async () => {
    const to = new Date('2026-09-19T12:00:00.000Z');
    const { service } = build({ counts: Array(18).fill(0) });
    const dashboard = await service.dashboard(OPERATIONS, { to });
    expect(dashboard.to).toEqual(to);
  });

  it.each([
    ['operations', OPERATIONS],
    ['clinical governance', GOVERNANCE],
    ['a care coordinator', COORDINATOR],
  ])('is readable by %s', async (_case, actor) => {
    const { service } = build({ counts: Array(18).fill(0) });
    await expect(service.dashboard(actor)).resolves.toBeDefined();
  });

  it('refuses an admin whose level does not run the control room', async () => {
    const { service } = build();
    await expect(service.dashboard(CONTENT)).rejects.toMatchObject({ status: 403 });
  });
});

describe('GovernanceService — the pending-summaries queue (FR-18.5)', () => {
  /** A DRAFT record still counts as pending: M-15's freeze makes a summary. */
  it('counts a draft record as still pending', async () => {
    const { service, consultationFindMany } = build();
    await service.pendingCaseSummaries(OPERATIONS);
    expect(consultationFindMany.mock.calls[0][0].where).toMatchObject({
      status: 'awaiting_documentation',
      OR: [{ clinicalRecord: null }, { clinicalRecord: { finalisedAt: null } }],
    });
  });

  /** A clinician's memory of a consultation is the thing that decays. */
  it('puts the longest wait first', async () => {
    const { service, consultationFindMany } = build();
    await service.pendingCaseSummaries(OPERATIONS);
    expect(consultationFindMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: 'asc' });
  });
});

describe('GovernanceService — provider quality (FR-18.6)', () => {
  /**
   * Read through M-05's registry rather than counted here, so the dashboard and
   * the provider's own profile show the same number. Two implementations of one
   * figure is two figures.
   */
  it('reads the figures through the registry, not by counting again', async () => {
    const { service, reliabilityOf } = build();
    const [quality] = await service.providerQuality(GOVERNANCE);
    expect(reliabilityOf).toHaveBeenCalledWith('doctor-1');
    expect(quality).toMatchObject({ doctorId: 'doctor-1', acceptanceRate: 0.8 });
  });

  it('refuses a care coordinator, who does not judge providers', async () => {
    const { service } = build();
    await expect(service.providerQuality(COORDINATOR)).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * FR-18.9. The BASIS of an assignment is not on the consultation — M-11 records
 * WHO on the row and WHY in the trail, because why is a record of a decision
 * rather than an attribute of the appointment.
 */
describe('GovernanceService — allocation oversight (FR-18.9)', () => {
  it('reads the basis from the audit log, the only place it exists', async () => {
    const { service, auditFindMany } = build({
      audit: [
        {
          entityId: 'consult-1',
          createdAt: new Date('2026-09-19T10:00:00.000Z'),
          actorType: 'system',
          metadata: { matchedOn: 'language', regionRelaxed: true },
        },
      ],
    });
    const [decision] = await service.allocationDecisions(GOVERNANCE);

    expect(auditFindMany.mock.calls[0][0].where).toMatchObject({
      entityType: { in: ['consultation_assignment', 'consultation_decline'] },
    });
    expect(decision).toMatchObject({
      consultationId: 'consult-1',
      basis: { matchedOn: 'language', regionRelaxed: true },
    });
  });

  it('can narrow to one consultation', async () => {
    const { service, auditFindMany } = build();
    await service.allocationDecisions(GOVERNANCE, { consultationId: 'consult-9' });
    expect(auditFindMany.mock.calls[0][0].where).toMatchObject({ entityId: 'consult-9' });
  });
});

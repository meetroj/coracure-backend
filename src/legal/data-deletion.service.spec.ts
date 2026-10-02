import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { DataDeletionService } from './data-deletion.service';

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

const request = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  patientId: 'patient-1',
  status: 'requested',
  reason: null,
  reviewedByAdminId: null,
  reviewedAt: null,
  reviewNote: null,
  executionOutcome: null,
  executedAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

type Row = Record<string, unknown>;
type FindFirstArgs = { where: { patientId: string; status: { in: string[] } } };
type UpdateArgs = { where: { id: string }; data: Row };

function build(over: { open?: unknown; found?: unknown } = {}) {
  const findFirst = vi
    .fn<(args: FindFirstArgs) => Promise<Row | null>>()
    .mockResolvedValue((over.open as Row | undefined) ?? null);
  const findUnique = vi.fn().mockResolvedValue(over.found ?? request());
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn().mockResolvedValue(request());
  const update = vi
    .fn<(args: UpdateArgs) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(request(args.data)));

  const prisma = {
    dataDeletionRequest: { findFirst, findUnique, findMany, create, update },
  } as unknown as PrismaService;
  const record = vi.fn().mockResolvedValue(undefined);

  return {
    service: new DataDeletionService(prisma, { record } as unknown as AuditService),
    findFirst,
    findMany,
    create,
    update,
    record,
  };
}

describe('DataDeletionService', () => {
  it('records a request with the patient and their reason', async () => {
    const { service, create } = build();
    await service.request('patient-1', 'No longer using the app', { ipAddress: '203.0.113.7' });
    expect(create).toHaveBeenCalledWith({
      data: { patientId: 'patient-1', reason: 'No longer using the app' },
    });
  });

  it('refuses a second request while one is still being handled', async () => {
    const { service, create } = build({ open: { id: 'req-0', status: 'in_review' } });
    await expect(service.request('patient-1', undefined, {})).rejects.toMatchObject({
      response: { code: 'DELETION_REQUEST_IN_PROGRESS' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('treats requested, in_review and approved as still open', async () => {
    const { service, findFirst } = build();
    await service.request('patient-1', undefined, {});
    expect(findFirst.mock.calls[0][0].where.status.in).toEqual([
      'requested',
      'in_review',
      'approved',
    ]);
  });

  it('lets a rejected or executed request be followed by a new one', async () => {
    // `findFirst` only matches the open statuses, so a closed row returns null.
    const { service, create } = build({ open: null });
    await service.request('patient-1', undefined, {});
    expect(create).toHaveBeenCalled();
  });

  it('records the reviewing admin and the time on a decision', async () => {
    const { service, update } = build();
    await service.review('req-1', { status: 'approved', note: 'Verified by phone' }, ADMIN);

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'approved',
      reviewedByAdminId: 'admin-1',
      reviewNote: 'Verified by phone',
    });
    expect(update.mock.calls[0][0].data.reviewedAt).toBeInstanceOf(Date);
  });

  it('approving does NOT delete anything - executed_at is what says that', async () => {
    const { service, update } = build();
    const result = await service.review('req-1', { status: 'approved' }, ADMIN);
    expect(update.mock.calls[0][0].data).not.toHaveProperty('executedAt');
    expect(result.executedAt).toBeNull();
  });

  it.each([['rejected'], ['executed'], ['failed']])(
    'refuses to review a request already %s',
    async (status) => {
      const { service } = build({ found: request({ status }) });
      await expect(
        service.review('req-1', { status: 'approved' }, ADMIN),
      ).rejects.toMatchObject({ response: { code: 'DELETION_REQUEST_NOT_PENDING' } });
    },
  );

  it('writes the execution outcome once, with what was deleted and what was kept', async () => {
    const { service, update } = build({ found: request({ status: 'approved' }) });
    const outcome = {
      deleted: { patients: 1, consents: 3 },
      retained: { audit_log: 'legal obligation', payments: 'tax retention' },
    };
    const result = await service.recordExecution('req-1', { succeeded: true, outcome });

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'executed',
      executionOutcome: outcome,
    });
    expect(result.executedAt).toBeInstanceOf(Date);
  });

  it('a failed run writes its reason into that same record', async () => {
    const { service, update } = build({ found: request({ status: 'approved' }) });
    await service.recordExecution('req-1', {
      succeeded: false,
      outcome: { error: 'storage bucket unreachable' },
    });

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'failed',
      executionOutcome: { error: 'storage bucket unreachable' },
    });
  });

  it('will not execute a request that was never approved', async () => {
    const { service } = build({ found: request({ status: 'requested' }) });
    await expect(
      service.recordExecution('req-1', { succeeded: true, outcome: {} }),
    ).rejects.toMatchObject({ response: { code: 'DELETION_REQUEST_NOT_PENDING' } });
  });
});

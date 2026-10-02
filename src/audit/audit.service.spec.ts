import { describe, expect, it, vi } from 'vitest';

import { AuditService } from './audit.service';
import { PrismaService } from '../database/prisma.service';

type CreateCall = { data: Record<string, unknown> };
type CreateMock = ReturnType<typeof createMock>;

const createMock = () => vi.fn<(args: CreateCall) => Promise<unknown>>().mockResolvedValue({});
const countMock = () => vi.fn<(args: unknown) => Promise<number>>().mockResolvedValue(0);

function serviceWith(create: CreateMock, count = countMock()) {
  const prisma = { auditLog: { create, count } } as unknown as PrismaService;
  return new AuditService(prisma);
}

const written = (create: CreateMock): Record<string, unknown> => create.mock.calls[0][0].data;

describe('AuditService', () => {
  it('writes the entry every module shares', async () => {
    const create = createMock();
    await serviceWith(create).record({
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'update',
      entityType: 'app_config',
      entityId: 'payments.gst_pct',
      metadata: { before: 18, after: 5 },
      ipAddress: '203.0.113.7',
    });

    expect(written(create)).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'update',
      entityType: 'app_config',
      entityId: 'payments.gst_pct',
      metadata: { before: 18, after: 5 },
      ipAddress: '203.0.113.7',
      consultationId: null,
    });
  });

  it('records a system action with no actor', async () => {
    const create = createMock();
    await serviceWith(create).record({
      actorType: 'system',
      action: 'create',
      entityType: 'service',
      entityId: 'api',
    });
    expect(written(create).actorId).toBeNull();
  });

  it('drops an unusable ip rather than losing the entry', async () => {
    const create = createMock();
    await serviceWith(create).record({
      actorType: 'patient',
      actorId: 'patient-1',
      action: 'login',
      entityType: 'patient',
      entityId: '+919876543210',
      ipAddress: 'not-an-ip',
    });
    expect(written(create).ipAddress).toBeNull();
  });

  it('trims values the columns cannot hold', async () => {
    const create = createMock();
    await serviceWith(create).record({
      actorType: 'system',
      action: 'webhook',
      entityType: 'x'.repeat(120),
      entityId: 'y'.repeat(120),
    });
    expect(written(create).entityType).toHaveLength(80);
    expect(written(create).entityId).toHaveLength(80);
  });

  it('never fails the caller when the write fails', async () => {
    const create = createMock().mockRejectedValue(new Error('database down'));
    await expect(
      serviceWith(create).record({
        actorType: 'system',
        action: 'create',
        entityType: 'service',
        entityId: 'api',
      }),
    ).resolves.toBeUndefined();
  });

  it('counts recent attempts for the rate limits', async () => {
    const count = countMock().mockResolvedValue(3);
    const since = new Date('2026-08-31T10:00:00Z');
    const total = await serviceWith(createMock(), count).countSince({
      action: 'login',
      entityType: 'patient',
      entityId: '+919876543210',
      since,
    });

    expect(total).toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: {
        action: 'login',
        entityType: 'patient',
        entityId: '+919876543210',
        createdAt: { gte: since },
      },
    });
  });
});

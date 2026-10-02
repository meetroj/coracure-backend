import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { RegionsService } from './regions.service';

type Row = Record<string, unknown>;

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

const region = (over: Row = {}) => ({
  id: 'region-1',
  code: 'karnataka',
  name: 'Karnataka',
  isActive: true,
  ...over,
});

function build(over: { row?: Row | null; providersInPool?: number } = {}) {
  const found = over.row === undefined ? region() : over.row;
  const findUnique = vi.fn().mockResolvedValue(found);
  const findMany = vi
    .fn<(args: { where?: Row }) => Promise<Row[]>>()
    .mockResolvedValue([found].filter(Boolean) as Row[]);
  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...region(), ...args.data }));
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...(found as Row), ...args.data }));
  const count = vi.fn().mockResolvedValue(over.providersInPool ?? 0);
  const prisma = {
    region: { findUnique, findMany, create, update },
    doctorRegion: { count },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  return {
    service: new RegionsService(prisma, { record } as unknown as AuditService),
    findMany,
    update,
    record,
  };
}

describe('RegionsService', () => {
  it('offers a patient only active regions', async () => {
    const { service, findMany } = build();
    await service.listActive();
    expect(findMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });

  it('refuses to disable a region providers still serve', async () => {
    // Disabling it would silently shrink every assignment matching on it.
    const { service, update } = build({ providersInPool: 4 });
    await expect(service.update('region-1', { isActive: false }, ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'STILL_IN_USE' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('disables an empty region', async () => {
    const { service, update } = build({ providersInPool: 0 });
    await service.update('region-1', { isActive: false }, ADMIN);
    expect(update.mock.calls[0][0].data).toEqual({ isActive: false });
  });

  it('404s a region that does not exist', async () => {
    const { service } = build({ row: null });
    await expect(service.assertUsable('nowhere')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a retired region as a patient preference', async () => {
    const { service } = build({ row: region({ isActive: false }) });
    await expect(service.assertUsable('region-1')).rejects.toMatchObject({ status: 400 });
  });

  it('accepts an active one', async () => {
    const { service } = build();
    await expect(service.assertUsable('region-1')).resolves.toBeUndefined();
  });

  it('records who added a region', async () => {
    const { service, record } = build();
    await service.create({ code: 'kerala', name: 'Kerala' }, ADMIN);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'create',
      entityType: 'region',
      actorId: 'admin-1',
    });
  });
});

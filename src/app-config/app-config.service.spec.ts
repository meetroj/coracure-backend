import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { AppConfigService } from './app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';

const pct = z.number().min(0).max(100);

type Row = Record<string, unknown>;

function build(
  row: { key: string; value: unknown; description?: string | null } | null,
  rows: Row[] = [],
) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const upsert = vi.fn<(args: { where: Row; create: Row; update: Row }) => Promise<Row>>().mockResolvedValue({});
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  // The admin listing reads every registered key at once.
  const findMany = vi.fn<(args: { where: Row }) => Promise<Row[]>>().mockResolvedValue(rows);
  const record = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    appConfig: { findUnique, upsert, createMany, findMany },
  } as unknown as PrismaService;
  const audit = { record } as unknown as AuditService;
  return {
    service: new AppConfigService(prisma, audit),
    findUnique,
    upsert,
    createMany,
    findMany,
    record,
  };
}

describe('AppConfigService', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
    });
  });

  it('reads a value in the shape the module expects', async () => {
    const { service } = build({ key: 'payments.gst_pct', value: 18 });
    await expect(service.get('payments.gst_pct', pct)).resolves.toBe(18);
  });

  it('returns nothing for a key that is not set', async () => {
    const { service } = build(null);
    await expect(service.get('payments.gst_pct', pct)).resolves.toBeUndefined();
  });

  it('refuses a stored value of the wrong shape', async () => {
    const { service } = build({ key: 'payments.gst_pct', value: 'eighteen' });
    await expect(service.get('payments.gst_pct', pct)).rejects.toThrowError(AppException);
  });

  it('treats a missing required value as a misconfigured platform', async () => {
    const { service } = build(null);
    await expect(service.getOrThrow('payments.gst_pct', pct)).rejects.toThrowError(/is not set/);
  });

  it('does not query the database twice inside the cache window', async () => {
    const { service, findUnique } = build({ key: 'booking.slot_hold_minutes', value: 10 });
    await service.get('booking.slot_hold_minutes', pct);
    await service.get('booking.slot_hold_minutes', pct);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('records who changed a value, from what to what', async () => {
    const { service, upsert, record } = build({ key: 'payments.gst_pct', value: 18 });
    await service.set('payments.gst_pct', 5, { type: 'admin', id: 'admin-1' });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'payments.gst_pct' } }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        actorId: 'admin-1',
        action: 'update',
        entityType: 'app_config',
        entityId: 'payments.gst_pct',
        metadata: { before: 18, after: 5 },
      }),
    );
  });

  it('serves the new value immediately after a change', async () => {
    const { service, findUnique } = build({ key: 'payments.gst_pct', value: 18 });
    await service.get('payments.gst_pct', pct);
    findUnique.mockResolvedValue({ key: 'payments.gst_pct', value: 5 });
    await service.set('payments.gst_pct', 5, { type: 'admin', id: 'admin-1' });
    await expect(service.get('payments.gst_pct', pct)).resolves.toBe(5);
  });

  it('seeds defaults without overwriting what an admin has set', async () => {
    const { service, createMany } = build(null);
    await service.seed([{ key: 'instant.acceptance_window_seconds', value: 60 }]);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ key: 'instant.acceptance_window_seconds', value: 60 }],
      skipDuplicates: true,
    });
  });
});

/**
 * *** THE SETTINGS SCREEN (FR-7.5, FR-13.7, FR-16.3). ***
 *
 * Three gates, and the third is the one that matters. A configuration table is
 * the easiest place in a platform to put a string where a number goes and not
 * find out until the next checkout fails for every patient.
 */
describe('AppConfigService — editing from the admin panel', () => {
  const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'finance' };
  const OPERATIONS: AuthenticatedActor = { type: 'admin', id: 'admin-2', level: 'operations' };
  const SUPER: AuthenticatedActor = { type: 'admin', id: 'admin-3', level: 'super_admin' };
  const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };

  /** Registers a few values the way a real module's `onModuleInit` does. */
  async function withRegistry(rows: Row[] = []) {
    const built = build(null, rows);
    await built.service.seed([
      {
        key: 'payments.gst_pct',
        value: 18,
        description: 'GST as a percentage.',
        schema: z.number().min(0).max(100),
        editableBy: ['finance'],
      },
      {
        key: 'compliance.audit_retention_days',
        value: 2920,
        description: 'How long audit entries are kept.',
        schema: z.number().int().min(365).max(7300),
        // Nobody but a super admin, via the blanket rule.
        editableBy: [],
      },
      {
        key: 'notifications.templates',
        value: [],
        description: 'Notification copy.',
        managedBy: 'notification templates',
      },
    ]);
    return built;
  }

  it('offers only values a module registered', async () => {
    const { service, findMany } = await withRegistry();
    await service.listForAdmin(SUPER);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      key: {
        in: ['payments.gst_pct', 'compliance.audit_retention_days', 'notifications.templates'],
      },
    });
  });

  it('says which values this admin may actually change', async () => {
    const { service } = await withRegistry();
    const listed = await service.listForAdmin(FINANCE);
    const byKey = Object.fromEntries(listed.map((e) => [e.key, e]));

    expect(byKey['payments.gst_pct']?.editable).toBe(true);
    // Finance does not set the legal retention period.
    expect(byKey['compliance.audit_retention_days']?.editable).toBe(false);
  });

  /** Super admin passes everything, as it does everywhere else. */
  it('lets a super admin change what no named level owns', async () => {
    const { service, upsert } = await withRegistry();
    await service.setFromAdmin('compliance.audit_retention_days', 1095, SUPER);
    expect(upsert).toHaveBeenCalled();
  });

  it('refuses an admin whose level does not own the setting', async () => {
    const { service, upsert } = await withRegistry();
    await expect(service.setFromAdmin('payments.gst_pct', 12, OPERATIONS)).rejects.toMatchObject({
      status: 403,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a key nobody registered', async () => {
    const { service } = await withRegistry();
    await expect(service.setFromAdmin('made.up.key', 1, SUPER)).rejects.toMatchObject({
      status: 404,
    });
  });

  /**
   * *** THE SHAPE CHECK. ***
   * `"banana"` where the billing code expects a number would break checkout for
   * every patient, and nothing would notice until it did.
   */
  it.each([
    ['a string where a number goes', 'banana'],
    ['a percentage over 100', 140],
    ['a null', null],
    ['an object', { pct: 18 }],
  ])('refuses %s', async (_case, value) => {
    const { service, upsert } = await withRegistry();
    await expect(service.setFromAdmin('payments.gst_pct', value, FINANCE)).rejects.toMatchObject({
      status: 400,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('accepts a value of the right shape', async () => {
    const { service, upsert } = await withRegistry();
    await service.setFromAdmin('payments.gst_pct', 12, FINANCE);
    expect(upsert.mock.calls[0][0].update).toMatchObject({ value: 12 });
  });

  /**
   * Two ways to change one value is how the two drift apart, and the
   * specialised screen usually validates something this one cannot — a
   * template's placeholders, for instance.
   */
  it('refuses a value that has its own screen, and says where', async () => {
    const { service } = await withRegistry();
    const error = await service
      .setFromAdmin('notifications.templates', [], SUPER)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ status: 409 });
    expect((error as { getResponse(): { message: string } }).getResponse().message).toContain(
      'notification templates',
    );
  });

  it('lists a screen-managed value as not editable, naming the screen', async () => {
    const { service } = await withRegistry();
    const listed = await service.listForAdmin(SUPER);
    const templates = listed.find((e) => e.key === 'notifications.templates');
    expect(templates).toMatchObject({ editable: false, managedBy: 'notification templates' });
  });

  it('refuses anybody who is not an admin', async () => {
    const { service } = await withRegistry();
    await expect(service.listForAdmin(DOCTOR)).rejects.toMatchObject({ status: 403 });
    await expect(service.setFromAdmin('payments.gst_pct', 12, DOCTOR)).rejects.toMatchObject({
      status: 403,
    });
  });

  /** The audit entry IS the configuration history — hence no versions table. */
  it('records who changed it, from what to what', async () => {
    const { service, record } = await withRegistry([{ key: 'payments.gst_pct', value: 18 }]);
    await service.setFromAdmin('payments.gst_pct', 12, FINANCE);

    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      entityType: 'app_config',
      entityId: 'payments.gst_pct',
      metadata: { after: 12 },
    });
  });
});

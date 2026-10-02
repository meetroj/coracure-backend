import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { LegalDocumentsService } from './legal-documents.service';

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'content' };

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  documentType: 'privacy_policy',
  version: '1.0',
  title: 'Privacy Policy',
  body: 'text',
  isCurrent: true,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

type Row = Record<string, unknown>;
type UpdateManyArgs = { where: Row; data: { isCurrent: boolean } };
type CreateArgs = { data: Row; select?: Row };

function build(over: { duplicate?: boolean; current?: unknown } = {}) {
  const findUnique = vi.fn().mockResolvedValue(over.duplicate ? { id: 'doc-0' } : null);
  const findFirst = vi.fn().mockResolvedValue(over.current ?? null);
  const findMany = vi.fn().mockResolvedValue([]);
  const updateMany = vi
    .fn<(args: UpdateManyArgs) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const create = vi
    .fn<(args: CreateArgs) => Promise<Row>>()
    .mockResolvedValue(doc({ id: 'doc-2', version: '2.0' }));

  const legalDocument = { findUnique, findFirst, findMany, updateMany, create };
  const prisma = {
    legalDocument,
    // The transaction callback receives a client with the same shape.
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ legalDocument })),
  } as unknown as PrismaService;

  const record = vi.fn().mockResolvedValue(undefined);
  return {
    service: new LegalDocumentsService(prisma, { record } as unknown as AuditService),
    findFirst,
    updateMany,
    create,
    record,
  };
}

describe('LegalDocumentsService', () => {
  it('serves the current version of a type', async () => {
    const { service, findFirst } = build({ current: doc() });
    await expect(service.getCurrent('privacy_policy')).resolves.toMatchObject({ version: '1.0' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { documentType: 'privacy_policy', isCurrent: true },
    });
  });

  it('says so plainly when nothing is published yet', async () => {
    const { service } = build({ current: null });
    await expect(service.getCurrent('privacy_policy')).rejects.toMatchObject({
      response: { code: 'DOCUMENT_NOT_PUBLISHED' },
    });
  });

  it('publishing INSERTS and never edits the version people accepted', async () => {
    const { service, create, updateMany } = build();
    await service.publish(
      { documentType: 'privacy_policy', version: '2.0', title: 'Privacy Policy', body: 'new text' },
      ADMIN,
    );

    // The old row is demoted, not rewritten: only `isCurrent` is touched.
    expect(updateMany).toHaveBeenCalledWith({
      where: { documentType: 'privacy_policy', isCurrent: true },
      data: { isCurrent: false },
    });
    expect(Object.keys(updateMany.mock.calls[0][0].data)).toEqual(['isCurrent']);
    expect(create.mock.calls[0][0].data).toMatchObject({ version: '2.0', isCurrent: true });
  });

  it('demotes the old version and inserts inside ONE transaction', async () => {
    const order: string[] = [];
    const legalDocument = {
      updateMany: vi.fn(() => {
        order.push('demote');
        return Promise.resolve({ count: 1 });
      }),
      create: vi.fn(() => {
        order.push('insert');
        return Promise.resolve(doc());
      }),
      findUnique: vi.fn().mockResolvedValue(null),
    };
    const transaction = vi.fn((fn: (tx: unknown) => unknown) => fn({ legalDocument }));
    const prisma = { legalDocument, $transaction: transaction } as unknown as PrismaService;
    const scoped = new LegalDocumentsService(prisma, {
      record: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);

    await scoped.publish(
      { documentType: 'terms_of_use', version: '3.0', title: 'Terms', body: 'x' },
      ADMIN,
    );

    // Demote must come first: the partial unique index allows one current row
    // per type, so inserting first would collide with the outgoing version.
    expect(order).toEqual(['demote', 'insert']);
    expect(transaction).toHaveBeenCalled();
  });

  it('refuses to republish a version number that already exists', async () => {
    const { service, create } = build({ duplicate: true });
    await expect(
      service.publish(
        { documentType: 'privacy_policy', version: '1.0', title: 'Privacy', body: 'rewritten' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'VERSION_ALREADY_EXISTS' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('records who published what', async () => {
    const { service, record } = build();
    await service.publish(
      { documentType: 'refund_policy', version: '2.0', title: 'Refunds', body: 'x' },
      ADMIN,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        actorId: 'admin-1',
        action: 'create',
        entityType: 'legal_document',
      }),
    );
  });
});

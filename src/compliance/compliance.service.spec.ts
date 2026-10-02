import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { DataDeletionService } from '../legal/data-deletion.service';
import { ComplianceError } from './compliance.errors';
import { ComplianceService, DEFAULT_RETENTION_DAYS } from './compliance.service';

type Row = Record<string, unknown>;

const SUPER: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'super_admin' };
const GOVERNANCE: AuthenticatedActor = {
  type: 'admin',
  id: 'admin-2',
  level: 'clinical_governance',
};
const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-3', level: 'finance' };
const CONTENT: AuthenticatedActor = { type: 'admin', id: 'admin-4', level: 'content' };
const COORDINATOR: AuthenticatedActor = { type: 'admin', id: 'admin-5', level: 'care_coordinator' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };

const entry = (over: Row = {}) => ({
  id: 42n,
  actorType: 'doctor',
  actorId: 'doctor-1',
  action: 'read',
  entityType: 'clinical_record',
  entityId: 'consult-1',
  consultationId: 'consult-1',
  metadata: { foo: 'bar' },
  ipAddress: '10.0.0.1',
  createdAt: new Date('2026-09-19T10:00:00.000Z'),
  ...over,
});

function build(over: { request?: Row | null; deleteThrows?: Error; retention?: number } = {}) {
  const auditFindMany = vi.fn<(args: Row) => Promise<Row[]>>().mockResolvedValue([entry()]);
  const auditDeleteMany = vi
    .fn<(args: Row) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 7 });

  const requestFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(
      over.request === undefined
        ? { id: 'req-1', patientId: 'patient-1', status: 'approved' }
        : over.request,
    );

  const patientDelete = vi.fn<() => Promise<Row>>().mockImplementation(() => {
    if (over.deleteThrows) return Promise.reject(over.deleteThrows);
    return Promise.resolve({});
  });

  const count = vi.fn<() => Promise<number>>().mockResolvedValue(3);

  const prisma = {
    auditLog: { findMany: auditFindMany, deleteMany: auditDeleteMany },
    dataDeletionRequest: { findUnique: requestFindUnique },
    patient: { delete: patientDelete },
    consultation: { count },
    patientFile: { count },
    complaint: { count },
    checkinResponse: { count },
  } as unknown as PrismaService;

  const record = vi.fn<(e: Row) => Promise<void>>().mockResolvedValue(undefined);
  const configGet = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(over.retention);
  const recordExecution = vi.fn<(id: string, result: Row) => Promise<Row>>().mockResolvedValue({});

  return {
    service: new ComplianceService(
      prisma,
      { record } as unknown as AuditService,
      { get: configGet } as unknown as AppConfigService,
      { recordExecution } as unknown as DataDeletionService,
    ),
    auditFindMany,
    auditDeleteMany,
    patientDelete,
    record,
    recordExecution,
  };
}

/**
 * *** WHAT AN ADMIN MAY READ DEPENDS ON THEIR LEVEL. ***
 *
 * The same least-privilege rule the rest of the panel runs on, applied to the
 * one table that describes all of it.
 */
describe('ComplianceService — who may read the trail', () => {
  it('lets a super admin read everything, unfiltered', async () => {
    const { service, auditFindMany } = build();
    await service.search(SUPER);
    expect(auditFindMany.mock.calls[0][0].where).not.toHaveProperty('entityType');
  });

  it('narrows clinical governance to clinical entities', async () => {
    const { service, auditFindMany } = build();
    await service.search(GOVERNANCE);
    const allowed = (auditFindMany.mock.calls[0][0].where as { entityType: { in: string[] } })
      .entityType.in;
    expect(allowed).toContain('clinical_record');
    expect(allowed).toContain('safety_alert');
    // Not theirs to read: money is finance's.
    expect(allowed).not.toContain('payment');
  });

  it('narrows finance to the money, and nothing clinical', async () => {
    const { service, auditFindMany } = build();
    await service.search(FINANCE);
    const allowed = (auditFindMany.mock.calls[0][0].where as { entityType: { in: string[] } })
      .entityType.in;
    expect(allowed).toContain('payment');
    expect(allowed).not.toContain('clinical_record');
    expect(allowed).not.toContain('safety_alert');
  });

  /** A content editor has no business reading the trail of a clinical record. */
  it('narrows a content editor to content', async () => {
    const { service, auditFindMany } = build();
    await service.search(CONTENT);
    const allowed = (auditFindMany.mock.calls[0][0].where as { entityType: { in: string[] } })
      .entityType.in;
    expect(allowed).toContain('content_item');
    expect(allowed).not.toContain('clinical_record');
    expect(allowed).not.toContain('payment');
  });

  it('gives a care coordinator the safety entities', async () => {
    const { service, auditFindMany } = build();
    await service.search(COORDINATOR);
    const allowed = (auditFindMany.mock.calls[0][0].where as { entityType: { in: string[] } })
      .entityType.in;
    expect(allowed).toContain('safety_alert');
  });

  it('refuses anybody who is not an admin', async () => {
    const { service } = build();
    await expect(service.search(DOCTOR)).rejects.toMatchObject({
      status: 403,
      response: { code: ComplianceError.NOT_PERMITTED },
    });
  });

  /**
   * *** SEARCHING THE LOG IS ITSELF LOGGED. *** Reading who saw what is a
   * privileged act, and a trail that does not record its own readers cannot
   * answer the question it exists for.
   */
  it('records the search it just ran', async () => {
    const { service, record } = build();
    await service.search(SUPER, { actorId: 'doctor-9' });
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      action: 'read',
      entityType: 'audit_log',
      entityId: 'search',
      metadata: { query: { actorId: 'doctor-9' }, returned: 1 },
    });
  });

  /** The QUERY, not the results — copying them would double the log per look. */
  it('records what was asked, not what came back', async () => {
    const { service, record } = build();
    await service.search(SUPER);
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('10.0.0.1');
  });

  it('stringifies the bigint id, which JSON cannot carry', async () => {
    const { service } = build();
    const [found] = await service.search(SUPER);
    expect(found?.id).toBe('42');
  });
});

describe('ComplianceService — retention (SRS 5.3)', () => {
  it('defaults conservatively when the client has set nothing', async () => {
    const { service } = build();
    await expect(service.retentionDays()).resolves.toBe(DEFAULT_RETENTION_DAYS);
  });

  it('uses the client’s figure when they have set one', async () => {
    const { service } = build({ retention: 1095 });
    await expect(service.retentionDays()).resolves.toBe(1095);
  });

  /**
   * *** BY AGE, AND ONLY BY AGE. ***
   * A retention sweep that could be aimed at an actor or a date range of
   * somebody's choosing is a way to erase one inconvenient entry — which is
   * exactly what an audit log exists to prevent.
   */
  it('deletes by age alone, with no other filter', async () => {
    const { service, auditDeleteMany } = build({ retention: 365 });
    await service.applyRetention(SUPER, new Date('2026-09-19T00:00:00.000Z'));

    const where = auditDeleteMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual(['createdAt']);
    expect((where.createdAt as { lt: Date }).lt.toISOString().slice(0, 10)).toBe('2025-09-19');
  });

  /** Retention is a legal decision, not an operational one. */
  it('is super admin only', async () => {
    const { service } = build();
    await expect(service.applyRetention(GOVERNANCE)).rejects.toMatchObject({ status: 403 });
  });

  /**
   * *** A SCHEDULED SWEEP IS NOT SOMEBODY'S DOING. ***
   *
   * "Who deleted these entries" must not answer with the name of whichever
   * admin happened to be configured. Nobody clicked it, and a trail that
   * implies somebody did is worse than one that says nothing.
   */
  it('attributes a scheduled sweep to the system, not to a person', async () => {
    const { service, record } = build({ retention: 365 });
    await service.applyRetentionAsSystem();
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      metadata: { scheduled: true },
    });
  });

  it('attributes a hand-run sweep to the admin who ran it', async () => {
    const { service, record } = build({ retention: 365 });
    await service.applyRetention(SUPER);
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      metadata: { scheduled: false },
    });
  });

  /** The trail records that a slice of the trail was retired. */
  it('writes its own entry', async () => {
    const { service, record } = build({ retention: 365 });
    await service.applyRetention(SUPER);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'delete',
      entityType: 'audit_log',
      entityId: 'retention',
      metadata: { retentionDays: 365, deleted: 7 },
    });
  });
});

describe('ComplianceService — executing an erasure (SRS 6.4)', () => {
  it('deletes the patient and lets the cascade do the rest', async () => {
    const { service, patientDelete } = build();
    const { outcome } = await service.executeDeletion('req-1', SUPER);
    expect(patientDelete).toHaveBeenCalledWith({ where: { id: 'patient-1' } });
    expect(outcome.deleted).toMatchObject({ patients: 1, consultations: 3 });
  });

  /** A subject access request asks what was kept. "Nothing, probably" is not an answer. */
  it('names what was retained and on what ground', async () => {
    const { service } = build();
    const { outcome } = await service.executeDeletion('req-1', SUPER);
    expect(Object.keys(outcome.retained)).toEqual(
      expect.arrayContaining(['payments', 'audit_log', 'clarification_cases']),
    );
    expect(outcome.retained.payments).toContain('statutory');
  });

  it('hands the outcome back to M-03 to record', async () => {
    const { service, recordExecution } = build();
    await service.executeDeletion('req-1', SUPER);
    expect(recordExecution.mock.calls[0][0]).toBe('req-1');
    expect(recordExecution.mock.calls[0][1]).toMatchObject({ succeeded: true });
  });

  /** M-03 owns the approval. Executing an unapproved request is not M-21's to do. */
  it.each(['requested', 'in_review', 'rejected', 'executed'])(
    'refuses to execute a %s request',
    async (status) => {
      const { service, patientDelete } = build({
        request: { id: 'req-1', patientId: 'patient-1', status },
      });
      await expect(service.executeDeletion('req-1', SUPER)).rejects.toMatchObject({
        status: 409,
        response: { code: ComplianceError.NOT_APPROVED },
      });
      expect(patientDelete).not.toHaveBeenCalled();
    },
  );

  it('refuses a request that does not exist', async () => {
    const { service } = build({ request: null });
    await expect(service.executeDeletion('nope', SUPER)).rejects.toMatchObject({ status: 404 });
  });

  it('is super admin only', async () => {
    const { service } = build();
    await expect(service.executeDeletion('req-1', GOVERNANCE)).rejects.toMatchObject({
      status: 403,
    });
  });

  /** A failure writes its reason into the SAME record — it is an outcome, not a different thing. */
  it('records a failure against the request rather than losing it', async () => {
    const { service, recordExecution } = build({
      deleteThrows: new Error('foreign key violation on payments'),
    });
    await expect(service.executeDeletion('req-1', SUPER)).rejects.toMatchObject({ status: 500 });

    const result = recordExecution.mock.calls[0][1] as {
      succeeded: boolean;
      outcome: { failure: string };
    };
    expect(result.succeeded).toBe(false);
    expect(result.outcome.failure).toContain('foreign key');
  });

  /**
   * *** THE PATIENT ID SURVIVES IN THE TRAIL, ON PURPOSE. ***
   * Erasing the evidence that an erasure happened would make the obligation
   * unprovable, which is the opposite of what SRS 6.7 keeps the log for.
   */
  it('leaves proof that the erasure happened', async () => {
    const { service, record } = build();
    await service.executeDeletion('req-1', SUPER);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'delete',
      entityType: 'patient',
      entityId: 'patient-1',
      metadata: { requestId: 'req-1', succeeded: true },
    });
  });
});

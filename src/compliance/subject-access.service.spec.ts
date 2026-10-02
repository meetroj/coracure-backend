import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { ComplianceError } from './compliance.errors';
import { SubjectAccessService } from './subject-access.service';

type Row = Record<string, unknown>;

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const OTHER_PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-9' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const SUPER: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'super_admin' };
const OPERATIONS: AuthenticatedActor = { type: 'admin', id: 'admin-2', level: 'operations' };

const patient = (over: Row = {}) => ({
  id: 'patient-1',
  mobileNumber: '+919000000001',
  fullName: 'A. Patient',
  dateOfBirth: new Date('1992-04-01'),
  gender: 'female',
  preferredLanguage: 'en',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

function build(over: { patient?: Row | null } = {}) {
  const patientFindUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.patient === undefined ? patient() : over.patient);

  const consultationFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue([
      { referenceCode: 'CC-4K2M-7QX9', followupStatus: 'active', followupStartsOn: new Date() },
    ]);
  const findMany = vi.fn<(args: Row) => Promise<Row[]>>().mockResolvedValue([]);

  const prisma = {
    patient: { findUnique: patientFindUnique },
    consultation: { findMany: consultationFindMany },
    consent: { findMany },
    clinicalRecord: { findMany },
    payment: { findMany },
    patientFile: { findMany },
    checkinResponse: { findMany },
    complaint: { findMany },
    notification: { findMany },
  } as unknown as PrismaService;

  const record = vi.fn<(e: Row) => Promise<void>>().mockResolvedValue(undefined);

  return {
    service: new SubjectAccessService(prisma, { record } as unknown as AuditService),
    patientFindUnique,
    consultationFindMany,
    findMany,
    record,
  };
}

/**
 * The counterpart to erasure. A data-rights regime that can delete but cannot
 * show is half a regime.
 */
describe('SubjectAccessService — a patient asking for their own data', () => {
  it('returns their profile and their records', async () => {
    const { service } = build();
    const document = await service.forSelf(PATIENT);

    expect(document.subject).toMatchObject({
      patientId: 'patient-1',
      mobileNumber: '+919000000001',
    });
    expect(document.consultations).toHaveLength(1);
    expect(document.generatedAt).toBeInstanceOf(Date);
  });

  it('scopes every read to that patient', async () => {
    const { service, consultationFindMany, findMany } = build();
    await service.forSelf(PATIENT);

    expect(consultationFindMany.mock.calls[0][0].where).toEqual({ patientId: 'patient-1' });
    // Everything else is scoped either directly or through the consultation.
    for (const call of findMany.mock.calls) {
      const where = JSON.stringify(call[0].where);
      expect(where).toContain('patient-1');
    }
  });

  it('refuses a doctor asking for a patient’s export', async () => {
    const { service } = build();
    await expect(service.forSelf(DOCTOR)).rejects.toMatchObject({
      status: 403,
      response: { code: ComplianceError.NOT_PERMITTED },
    });
  });

  /**
   * *** THE FILE METADATA, NEVER THE OBJECT KEYS. ***
   * A storage key in a document that gets emailed around is a durable pointer
   * to a private record. Files download from the patient's own account, through
   * a link that expires.
   */
  it('lists files by name and date, never by storage key', async () => {
    const { service, findMany } = build();
    await service.forSelf(PATIENT);

    const fileCall = findMany.mock.calls.find((call) =>
      JSON.stringify(call[0].select ?? {}).includes('fileName'),
    );
    expect(fileCall).toBeDefined();
    expect(JSON.stringify(fileCall?.[0].select)).not.toContain('storageKey');
  });

  /**
   * A document the patient removed is not data the platform still holds about
   * them, and listing it would answer the question wrongly in the direction
   * that alarms people.
   */
  it('leaves out files the patient already deleted', async () => {
    const { service, findMany } = build();
    await service.forSelf(PATIENT);

    const fileCall = findMany.mock.calls.find((call) =>
      JSON.stringify(call[0].select ?? {}).includes('fileName'),
    );
    expect(fileCall?.[0].where).toMatchObject({ deletedAt: null });
  });

  /**
   * *** WHAT IS LEFT OUT IS NAMED. ***
   * A person asking what is held about them is owed the shape of the answer as
   * well as its contents — and each omission is a decision the client's counsel
   * should confirm, not one this module makes quietly.
   */
  it('says what is not included, and why', async () => {
    const { service } = build();
    const document = await service.forSelf(PATIENT);

    expect(Object.keys(document.notIncluded)).toEqual(
      expect.arrayContaining([
        'complaint_internal_notes',
        'clarification_cases',
        'audit_log',
        'file_contents',
      ]),
    );
    expect(document.notIncluded.complaint_internal_notes).toContain('legal advice');
  });

  /** Handing over everything about somebody is itself worth recording. */
  it('records the export without copying it into the trail', async () => {
    const { service, record } = build();
    await service.forSelf(PATIENT);

    const entry = record.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: 'export',
      entityType: 'subject_access',
      entityId: 'patient-1',
      metadata: { consultations: 1, bySelf: true },
    });
    // The SHAPE, not the contents — copying it would double every record it holds.
    expect(JSON.stringify(entry)).not.toContain('+919000000001');
  });
});

describe('SubjectAccessService — an admin answering a written request', () => {
  it('produces the same document for a named patient', async () => {
    const { service } = build();
    await expect(service.forPatient('patient-1', SUPER)).resolves.toMatchObject({
      subject: { patientId: 'patient-1' },
    });
  });

  /**
   * The single widest read of one person's data in the platform, so the level
   * that can perform it is the level that can also authorise an erasure.
   */
  it('is super admin only', async () => {
    const { service } = build();
    await expect(service.forPatient('patient-1', OPERATIONS)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('records that an ADMIN produced it, not the patient', async () => {
    const { service, record } = build();
    await service.forPatient('patient-1', SUPER);
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      metadata: { bySelf: false },
    });
  });

  it('refuses a patient who does not exist', async () => {
    const { service } = build({ patient: null });
    await expect(service.forPatient('nope', SUPER)).rejects.toMatchObject({ status: 404 });
  });

  /** A patient can only ever ask for their own; there is no id to pass. */
  it('gives a patient no way to name somebody else', async () => {
    const { service, patientFindUnique } = build();
    await service.forSelf(OTHER_PATIENT);
    expect(patientFindUnique.mock.calls[0][0]).toEqual({ where: { id: 'patient-9' } });
  });
});

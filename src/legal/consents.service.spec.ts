import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { ConsentsService } from './consents.service';
import { LegalDocumentsService } from './legal-documents.service';

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

const CURRENT_DOC = {
  id: 'doc-current',
  documentType: 'teleconsultation_consent' as const,
  version: '2.0',
  title: 'Teleconsultation Consent',
  body: 'text',
  isCurrent: true,
  createdAt: new Date(),
};

type ConsentCreate = { data: Record<string, unknown> };

function build(over: { existing?: unknown; count?: number; current?: unknown } = {}) {
  const findFirst = vi.fn().mockResolvedValue(over.existing ?? null);
  const findMany = vi.fn().mockResolvedValue([]);
  const count = vi.fn().mockResolvedValue(over.count ?? 0);
  const create = vi
    .fn<(args: ConsentCreate) => Promise<Record<string, unknown>>>()
    .mockImplementation((args) =>
      Promise.resolve({
        id: 'consent-1',
        acceptedAt: new Date('2026-08-31T00:00:00Z'),
        ...args.data,
      }),
    );
  const prisma = { consent: { findFirst, findMany, count, create } } as unknown as PrismaService;

  const getCurrent = vi.fn().mockResolvedValue(over.current ?? CURRENT_DOC);
  const documents = { getCurrent } as unknown as LegalDocumentsService;
  const record = vi.fn().mockResolvedValue(undefined);

  return {
    service: new ConsentsService(prisma, documents, { record } as unknown as AuditService),
    create,
    count,
    getCurrent,
    record,
  };
}

describe('ConsentsService', () => {
  it('pins acceptance to the CURRENT version, which the client never names', async () => {
    const { service, create, getCurrent } = build();
    const result = await service.accept(PATIENT, 'teleconsultation_consent', {
      ipAddress: '203.0.113.7',
    });

    expect(getCurrent).toHaveBeenCalledWith('teleconsultation_consent');
    expect(create.mock.calls[0][0].data).toMatchObject({
      patientId: 'patient-1',
      legalDocumentId: 'doc-current',
      documentType: 'teleconsultation_consent',
      ipAddress: '203.0.113.7',
    });
    expect(result.version).toBe('2.0');
  });

  it('keeps the IP, which is the legal evidence of acceptance', async () => {
    const { service, create } = build();
    await service.accept(PATIENT, 'privacy_policy', { ipAddress: '198.51.100.4' });
    expect(create.mock.calls[0][0].data.ipAddress).toBe('198.51.100.4');
  });

  it('sets patient_id for a patient and doctor_id for a doctor, never both', async () => {
    const patient = build();
    await patient.service.accept(PATIENT, 'terms_of_use', {});
    expect(patient.create.mock.calls[0][0].data).toMatchObject({ patientId: 'patient-1' });
    expect(patient.create.mock.calls[0][0].data).not.toHaveProperty('doctorId');

    const doctor = build();
    await doctor.service.accept(DOCTOR, 'doctor_agreement', {});
    expect(doctor.create.mock.calls[0][0].data).toMatchObject({ doctorId: 'doctor-1' });
    expect(doctor.create.mock.calls[0][0].data).not.toHaveProperty('patientId');
  });

  it('refuses an admin: a consent belongs to a patient or a doctor', async () => {
    const { service, create } = build();
    await expect(service.accept(ADMIN, 'terms_of_use', {})).rejects.toMatchObject({
      response: { code: 'CONSENT_REQUIRED' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('accepting twice is a no-op, so a retried request is not an error', async () => {
    const { service, create } = build({
      existing: {
        id: 'consent-1',
        documentType: 'teleconsultation_consent',
        legalDocumentId: 'doc-current',
        acceptedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });

    const result = await service.accept(PATIENT, 'teleconsultation_consent', {});
    expect(create).not.toHaveBeenCalled();
    expect(result.acceptedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('*** THE GATE *** passes when the current version has been accepted', async () => {
    const { service } = build({ count: 1 });
    await expect(service.assertTeleconsultationConsent(PATIENT)).resolves.toBeUndefined();
  });

  it('*** THE GATE *** refuses when it has not', async () => {
    const { service } = build({ count: 0 });
    await expect(service.assertTeleconsultationConsent(PATIENT)).rejects.toMatchObject({
      response: { code: 'CONSENT_REQUIRED' },
    });
  });

  it('only a consent against the CURRENT version counts, so a new version re-asks', async () => {
    const { service, count } = build({ count: 0 });
    await service.hasCurrentConsent(PATIENT, 'teleconsultation_consent');

    expect(count).toHaveBeenCalledWith({
      where: {
        patientId: 'patient-1',
        documentType: 'teleconsultation_consent',
        legalDocument: { isCurrent: true },
      },
    });
  });
});

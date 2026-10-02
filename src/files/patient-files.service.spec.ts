import { PatientFileCategory } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ObjectStorage } from '../storage/object-storage';
import { ConsultationAccess, ConsultationContext } from './consultation-access';
import { PatientFilesService } from './patient-files.service';
import { patientFileKey } from './patient-file-storage';

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const OTHER_PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-2' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'super_admin' };

type Row = Record<string, unknown>;

const file = (over: Row = {}) => ({
  id: 'file-1',
  fileCategory: PatientFileCategory.report,
  patientId: 'patient-1',
  uploadedByDoctorId: null,
  consultationId: null,
  reportRequestId: null,
  clarificationCaseId: null,
  storageKey: 'patient-files/patient-1/report/abc.pdf',
  fileName: 'blood-report.pdf',
  deletedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
});

const consultation = (over: Partial<ConsultationContext> = {}): ConsultationContext => ({
  id: 'consult-1',
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  isCompleted: false,
  ...over,
});

function build(
  over: {
    found?: Row | null;
    files?: Row[];
    request?: Row | null;
    context?: ConsultationContext | null;
    isTreating?: boolean;
  } = {},
) {
  const findFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? file() : over.found);
  const findMany = vi
    .fn<(args: { where: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.files ?? [file()]);
  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(file(args.data)));
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(file(args.data)));
  const requestFindUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.request ?? null);
  const requestUpdate = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockResolvedValue({});

  const tx = {
    patientFile: { create },
    reportRequest: { update: requestUpdate },
  };
  const patientFindUnique = vi.fn().mockResolvedValue({ fullName: 'Anita Sharma' });
  const prisma = {
    patientFile: { findFirst, findMany, create, update },
    reportRequest: { findUnique: requestFindUnique },
    patient: { findUnique: patientFindUnique },
    $transaction: vi
      .fn<(work: (client: typeof tx) => Promise<Row>) => Promise<Row>>()
      .mockImplementation((work) => work(tx)),
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);
  const signUpload = vi.fn().mockResolvedValue({ url: 'https://signed', expiresInSeconds: 300 });
  const signDownload = vi.fn().mockResolvedValue({ url: 'https://signed', expiresInSeconds: 300 });
  const storage = {
    signUpload,
    signDownload,
    remove: vi.fn(),
    stat: vi.fn().mockResolvedValue(null),
  } as unknown as ObjectStorage;

  const contextOf = vi
    .fn<(id: string) => Promise<ConsultationContext | null>>()
    .mockResolvedValue(over.context === undefined ? null : over.context);
  const isTreating = vi
    .fn<(doctorId: string, patientId: string) => Promise<boolean>>()
    .mockResolvedValue(over.isTreating ?? false);
  const consultations = { contextOf, isTreating } as ConsultationAccess;

  return {
    service: new PatientFilesService(
      prisma,
      { record } as unknown as AuditService,
      { notify } as unknown as NotificationsService,
      storage,
      consultations,
    ),
    findMany,
    create,
    update,
    requestUpdate,
    notify,
    record,
    signDownload,
    isTreating,
  };
}

describe('PatientFilesService — the access rule', () => {
  it('lets a patient read their own files', async () => {
    const { service, findMany } = build();
    await service.listFor('patient-1', PATIENT);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      patientId: 'patient-1',
      deletedAt: null,
    });
  });

  it('refuses one patient another patient’s files', async () => {
    const { service } = build();
    await expect(service.listFor('patient-1', OTHER_PATIENT)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FILE_NOT_FOUND' },
    });
  });

  it('refuses a doctor who has never consulted that patient', async () => {
    // *** THE RULE THE MODULE IS JUDGED ON. *** Being a verified doctor says
    // they may practise here; it says nothing about reading THIS patient.
    const { service, isTreating } = build({ isTreating: false });
    await expect(service.listFor('patient-1', DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FILE_NOT_FOUND' },
    });
    expect(isTreating).toHaveBeenCalledWith('doctor-1', 'patient-1');
  });

  it('lets a treating doctor read the whole history, including what predates their booking', async () => {
    // Which is the point of holding medical history against the patient rather
    // than one consultation.
    const { service, findMany } = build({ isTreating: true });
    await service.listFor('patient-1', DOCTOR);
    // No consultation filter: everything for that patient.
    expect(findMany.mock.calls[0][0].where).toEqual({ patientId: 'patient-1', deletedAt: null });
  });

  it('refuses an ADMIN, who has the panel but not the clinical record', async () => {
    // SRS 6.2. A support question about a file is answered from the audit
    // trail, which records every read without exposing one.
    const { service } = build({ isTreating: true });
    await expect(service.listFor('patient-1', ADMIN)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FILE_NOT_FOUND' },
    });
  });

  it('answers "not found" rather than "not yours", so nothing is confirmed', async () => {
    const { service } = build({ found: null });
    await expect(service.downloadUrl('file-1', PATIENT)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FILE_NOT_FOUND' },
    });
  });

  it('never exposes a de-identified clarification copy through the patient path', async () => {
    // Its `patient_id` is null by construction, so there is no owner to match.
    const { service } = build({
      found: file({ patientId: null, clarificationCaseId: 'case-1' }),
    });
    await expect(service.downloadUrl('file-1', PATIENT)).rejects.toMatchObject({
      response: { code: 'FILE_NOT_FOUND' },
    });
  });
});

describe('PatientFilesService — upload', () => {
  it('mints the key itself, so a client cannot choose where its file lands', async () => {
    const { service } = build();
    const { storageKey } = await service.requestUpload('patient-1', {
      category: 'report',
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
    });
    expect(storageKey.startsWith('patient-files/patient-1/report/')).toBe(true);
    expect(storageKey).not.toContain('scan');
  });

  it('refuses a key issued to somebody else', async () => {
    const { service, create } = build();
    await expect(
      service.confirmUpload('patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        storageKey: patientFileKey('patient-2', PatientFileCategory.report, 'scan.pdf'),
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'UPLOAD_NOT_RECOGNISED' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a category a client may not send', async () => {
    // A prescription PDF is generated by the platform. Accepting one from a
    // client would let a patient file a prescription nobody wrote.
    const { service } = build();
    await expect(
      service.requestUpload('patient-1', {
        category: 'prescription_pdf' as 'report',
        fileName: 'rx.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ response: { code: 'CATEGORY_NOT_UPLOADABLE' } });
  });

  it('holds medical history against the patient, never one booking', async () => {
    // Pinned to a consultation it would be invisible at the next one.
    const { service, create } = build({ context: consultation() });
    await service.confirmUpload('patient-1', {
      category: 'medical_history',
      fileName: 'history.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.medical_history, 'history.pdf'),
      consultationId: 'consult-1',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ consultationId: null });
  });

  it('attaches a report to a booking that is the patient’s own', async () => {
    const { service, create } = build({ context: consultation() });
    await service.confirmUpload('patient-1', {
      category: 'report',
      fileName: 'scan.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'scan.pdf'),
      consultationId: 'consult-1',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ consultationId: 'consult-1' });
  });

  it('refuses to attach a file to somebody else’s booking', async () => {
    const { service } = build({ context: consultation({ patientId: 'patient-2' }) });
    await expect(
      service.confirmUpload('patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'scan.pdf'),
        consultationId: 'consult-1',
      }),
    ).rejects.toMatchObject({ status: 404, response: { code: 'CONSULTATION_NOT_FOUND' } });
  });

  it('does not record the file NAME in the audit trail', async () => {
    // "hiv-result.pdf" in a metadata blob is the clinical detail the trail
    // exists to protect.
    const { service, record } = build();
    await service.confirmUpload('patient-1', {
      category: 'report',
      fileName: 'hiv-result.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'hiv-result.pdf'),
    });
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('hiv');
  });
});

describe('PatientFilesService — a doctor uploading on a patient’s behalf', () => {
  it('refuses to even mint a URL for a patient the doctor has never treated', async () => {
    const { service, isTreating } = build({ isTreating: false });
    await expect(
      service.requestDoctorUpload('doctor-1', 'patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ status: 404, response: { code: 'FILE_NOT_FOUND' } });
    expect(isTreating).toHaveBeenCalledWith('doctor-1', 'patient-1');
  });

  it('mints a key under the patient, for a doctor who treats them', async () => {
    const { service } = build({ isTreating: true });
    const { storageKey } = await service.requestDoctorUpload('doctor-1', 'patient-1', {
      category: 'report',
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
    });
    expect(storageKey.startsWith('patient-files/patient-1/report/')).toBe(true);
  });

  it('attaches the file to the consultation and records who uploaded it', async () => {
    const { service, create } = build({ isTreating: true, context: consultation() });
    const result = await service.confirmDoctorUpload('doctor-1', 'patient-1', {
      category: 'report',
      fileName: 'scan.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'scan.pdf'),
      consultationId: 'consult-1',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      consultationId: 'consult-1',
      uploadedByDoctorId: 'doctor-1',
    });
    expect(result.uploadedByDoctorId).toBe('doctor-1');
  });

  it('refuses a consultation the doctor does not treat, even if it is this patient’s', async () => {
    // Being treating-with-this-patient overall is not the same as owning
    // THIS booking — a second doctor on the same patient must not write here.
    const { service } = build({
      isTreating: true,
      context: consultation({ doctorId: 'doctor-2' }),
    });
    await expect(
      service.confirmDoctorUpload('doctor-1', 'patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'scan.pdf'),
        consultationId: 'consult-1',
      }),
    ).rejects.toMatchObject({ status: 404, response: { code: 'CONSULTATION_NOT_FOUND' } });
  });

  it('refuses a storage key minted for a different patient', async () => {
    const { service, create } = build({ isTreating: true, context: consultation() });
    await expect(
      service.confirmDoctorUpload('doctor-1', 'patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        storageKey: patientFileKey('patient-2', PatientFileCategory.report, 'scan.pdf'),
        consultationId: 'consult-1',
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'UPLOAD_NOT_RECOGNISED' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('holds medical history against the patient, never the booking, even from a doctor', async () => {
    const { service, create } = build({ isTreating: true, context: consultation() });
    await service.confirmDoctorUpload('doctor-1', 'patient-1', {
      category: 'medical_history',
      fileName: 'history.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.medical_history, 'history.pdf'),
      consultationId: 'consult-1',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ consultationId: null });
  });
});

describe('PatientFilesService — answering a request', () => {
  const openRequest = { id: 'request-1', consultationId: 'consult-1', status: 'open' };

  it('fulfils the request by the file arriving, in one transaction', async () => {
    // There is no `fulfilled_at` on the request: this file's `created_at` IS
    // that time, and one timestamp cannot disagree with itself.
    const { service, create, requestUpdate } = build({
      context: consultation(),
      request: openRequest,
    });
    await service.confirmUpload('patient-1', {
      category: 'report',
      fileName: 'thyroid.pdf',
      storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'thyroid.pdf'),
      consultationId: 'consult-1',
      reportRequestId: 'request-1',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({ reportRequestId: 'request-1' });
    expect(requestUpdate.mock.calls[0][0].data).toEqual({ status: 'fulfilled' });
  });

  it('refuses a request that is already closed', async () => {
    const { service } = build({
      context: consultation(),
      request: { ...openRequest, status: 'cancelled' },
    });
    await expect(
      service.confirmUpload('patient-1', {
        category: 'report',
        fileName: 'late.pdf',
        storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'late.pdf'),
        consultationId: 'consult-1',
        reportRequestId: 'request-1',
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'REPORT_REQUEST_CLOSED' } });
  });

  it('refuses a request raised on somebody else’s consultation', async () => {
    const { service } = build({
      context: consultation({ patientId: 'patient-2' }),
      request: openRequest,
    });
    await expect(
      service.confirmUpload('patient-1', {
        category: 'report',
        fileName: 'scan.pdf',
        storageKey: patientFileKey('patient-1', PatientFileCategory.report, 'scan.pdf'),
        consultationId: 'consult-1',
        reportRequestId: 'request-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'REPORT_REQUEST_NOT_FOUND' } });
  });
});

describe('PatientFilesService — deletion', () => {
  it('lets a patient remove an upload not tied to any booking', async () => {
    const { service, update } = build();
    await service.deleteOwnFile('file-1', 'patient-1');
    // A SOFT delete: the row is hidden, the object is left for M-21's retention
    // job, so the DPDP deletion path stays in one place.
    expect(update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses once a completed consultation has relied on it', async () => {
    const { service, update } = build({
      found: file({ consultationId: 'consult-1' }),
      context: consultation({ isCompleted: true }),
    });
    await expect(service.deleteOwnFile('file-1', 'patient-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'FILE_IS_PART_OF_A_RECORD' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('allows it while that consultation is still open', async () => {
    const { service, update } = build({
      found: file({ consultationId: 'consult-1' }),
      context: consultation({ isCompleted: false }),
    });
    await service.deleteOwnFile('file-1', 'patient-1');
    expect(update).toHaveBeenCalled();
  });

  it('keeps a file whose consultation cannot be resolved', async () => {
    // Unresolvable is treated as "keep". A file attached to a booking this
    // module cannot read about is not one to delete on a guess.
    const { service } = build({ found: file({ consultationId: 'consult-1' }), context: null });
    await expect(service.deleteOwnFile('file-1', 'patient-1')).rejects.toMatchObject({
      response: { code: 'FILE_IS_PART_OF_A_RECORD' },
    });
  });

  it('refuses to let a patient delete what their doctor uploaded', async () => {
    // It is the clinician's entry about them, not their file.
    const { service } = build({ found: file({ uploadedByDoctorId: 'doctor-1' }) });
    await expect(service.deleteOwnFile('file-1', 'patient-1')).rejects.toMatchObject({
      response: { code: 'FILE_IS_PART_OF_A_RECORD' },
    });
  });

  it('will not delete another patient’s file', async () => {
    const { service } = build({ found: null });
    await expect(service.deleteOwnFile('file-1', 'patient-1')).rejects.toMatchObject({
      status: 404,
      response: { code: 'FILE_NOT_FOUND' },
    });
  });
});

describe('PatientFilesService — download', () => {
  it('signs a short-lived URL and records the read', async () => {
    const { service, signDownload, record } = build();
    const url = await service.downloadUrl('file-1', PATIENT);

    expect(url.expiresInSeconds).toBeLessThanOrEqual(3600);
    expect(signDownload).toHaveBeenCalledWith(
      'patient-files/patient-1/report/abc.pdf',
      'blood-report.pdf',
    );
    // These are somebody's clinical records, so every read leaves a trail.
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'read',
      entityType: 'patient_file',
      entityId: 'file-1',
    });
  });

  it('never returns the storage key to a client', async () => {
    const { service } = build();
    const listed = await service.listFor('patient-1', PATIENT);
    expect(JSON.stringify(listed)).not.toContain('patient-files/');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { EventBus } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CredentialStorage } from './credential-storage';
import { DoctorVerificationService } from './doctor-verification.service';
import { SpecialtyCatalogue } from './specialty-catalogue';

type Row = Record<string, unknown>;

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'clinical_governance' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };

const REQUIRED = ['degree_certificate', 'registration_certificate', 'identity_proof'];

const document = (over: Row = {}) => ({
  id: 'document-1',
  doctorId: 'doctor-1',
  documentType: 'degree_certificate',
  storageKey: 'doctor-documents/doctor-1/degree_certificate/abc.pdf',
  fileName: 'degree.pdf',
  reviewStatus: 'pending',
  verifiedByAdminId: null,
  verifiedAt: null,
  rejectionReason: null,
  createdAt: new Date('2026-08-20T00:00:00.000Z'),
  ...over,
});

function build(
  over: {
    doctor?: Row | null;
    documents?: Row[];
    required?: string[];
    foundDocument?: Row | null;
    /** FR-19.7: true when the specialty uses the DOCTOR registration form. */
    requiresRegistrationNumber?: boolean;
  } = {},
) {
  const doctorRow =
    over.doctor === undefined
      ? {
          id: 'doctor-1',
          specialtyId: 'specialty-1',
          verificationStatus: 'under_review',
          registrationNumber: 'MCI-12345',
        }
      : over.doctor;

  const doctorFindUnique = vi.fn().mockResolvedValue(doctorRow);
  const doctorUpdate = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row | null>>()
    .mockResolvedValue(doctorRow);
  const documentFindMany = vi.fn().mockResolvedValue(over.documents ?? []);
  const documentFindUnique = vi
    .fn()
    .mockResolvedValue(over.foundDocument === undefined ? document() : over.foundDocument);
  const documentCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(document(args.data)));
  const documentUpdate = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(document(args.data)));

  const prisma = {
    doctor: { findUnique: doctorFindUnique, update: doctorUpdate },
    doctorDocument: {
      findMany: documentFindMany,
      findUnique: documentFindUnique,
      create: documentCreate,
      update: documentUpdate,
    },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const publish = vi.fn<(event: string, payload: Row) => void>();
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);
  const signUpload = vi.fn().mockResolvedValue({ url: 'https://signed', expiresInSeconds: 300 });
  const signDownload = vi.fn().mockResolvedValue({ url: 'https://signed', expiresInSeconds: 300 });
  const storage = { signUpload, signDownload, remove: vi.fn() } as unknown as CredentialStorage;
  const catalogue = {
    requiredDocuments: vi.fn().mockResolvedValue(over.required ?? REQUIRED),
    canPrescribe: vi.fn().mockResolvedValue(false),
    requiresRegistrationNumber: vi.fn().mockResolvedValue(over.requiresRegistrationNumber ?? true),
  } as unknown as SpecialtyCatalogue;

  return {
    service: new DoctorVerificationService(
      prisma,
      { record } as unknown as AuditService,
      { publish } as unknown as EventBus,
      { notify } as unknown as NotificationsService,
      storage,
      catalogue,
    ),
    doctorUpdate,
    documentCreate,
    documentUpdate,
    record,
    publish,
    notify,
    signDownload,
  };
}

describe('DoctorVerificationService.confirmUpload', () => {
  it('refuses a storage key that was minted for another doctor', async () => {
    const { service, documentCreate } = build();

    await expect(
      service.confirmUpload('doctor-1', {
        documentType: 'degree_certificate',
        fileName: 'degree.pdf',
        storageKey: 'doctor-documents/doctor-2/degree_certificate/abc.pdf',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'UPLOAD_NOT_RECOGNISED' },
    });
    expect(documentCreate).not.toHaveBeenCalled();
  });

  it('moves the first upload from pending to under_review', async () => {
    const { service, doctorUpdate } = build({
      doctor: { id: 'doctor-1', specialtyId: 'specialty-1', verificationStatus: 'pending' },
    });

    await service.confirmUpload('doctor-1', {
      documentType: 'degree_certificate',
      fileName: 'degree.pdf',
      storageKey: 'doctor-documents/doctor-1/degree_certificate/abc.pdf',
    });

    expect(doctorUpdate.mock.calls[0][0].data).toEqual({ verificationStatus: 'under_review' });
  });

  it('leaves a doctor already under review where they are', async () => {
    const { service, doctorUpdate } = build();
    await service.confirmUpload('doctor-1', {
      documentType: 'identity_proof',
      fileName: 'aadhaar.pdf',
      storageKey: 'doctor-documents/doctor-1/identity_proof/abc.pdf',
    });
    expect(doctorUpdate).not.toHaveBeenCalled();
  });

  it('never returns the storage key to the client', async () => {
    const { service } = build();
    const summary = await service.confirmUpload('doctor-1', {
      documentType: 'identity_proof',
      fileName: 'aadhaar.pdf',
      storageKey: 'doctor-documents/doctor-1/identity_proof/abc.pdf',
    });
    expect(summary).not.toHaveProperty('storageKey');
  });
});

describe('DoctorVerificationService.progressOf', () => {
  it('counts a requirement as met only once a document of that type is approved', async () => {
    const { service } = build({
      documents: [
        document({ documentType: 'degree_certificate', reviewStatus: 'approved' }),
        document({ id: 'd2', documentType: 'registration_certificate', reviewStatus: 'pending' }),
      ],
    });

    const progress = await service.progressOf('doctor-1');
    expect(progress.approved).toEqual(['degree_certificate']);
    expect(progress.outstanding).toEqual(['registration_certificate', 'identity_proof']);
    expect(progress.readyForVerification).toBe(false);
  });

  it('treats a rejected first attempt followed by an approved second as satisfied', async () => {
    const { service } = build({
      required: ['degree_certificate'],
      documents: [
        document({ reviewStatus: 'approved' }),
        document({ id: 'd0', reviewStatus: 'rejected', rejectionReason: 'Illegible' }),
      ],
    });

    const progress = await service.progressOf('doctor-1');
    expect(progress.outstanding).toEqual([]);
    expect(progress.rejected).toEqual([]);
    expect(progress.readyForVerification).toBe(true);
  });

  it('names what the doctor has to re-upload', async () => {
    const { service } = build({
      required: ['identity_proof'],
      documents: [
        document({
          documentType: 'identity_proof',
          reviewStatus: 'rejected',
          rejectionReason: 'Blurred',
        }),
      ],
    });

    const progress = await service.progressOf('doctor-1');
    expect(progress.rejected).toEqual(['identity_proof']);
    expect(progress.documents[0].rejectionReason).toBe('Blurred');
  });
});

describe('DoctorVerificationService.reviewDocument', () => {
  it('refuses a rejection with no reason - the doctor has to act on it', async () => {
    const { service, documentUpdate } = build();

    await expect(
      service.reviewDocument('document-1', { approved: false }, ADMIN),
    ).rejects.toMatchObject({ status: 400 });
    expect(documentUpdate).not.toHaveBeenCalled();
  });

  it('records which admin approved this document, and when', async () => {
    const { service, documentUpdate } = build();
    await service.reviewDocument('document-1', { approved: true }, ADMIN);

    expect(documentUpdate.mock.calls[0][0].data).toMatchObject({
      reviewStatus: 'approved',
      verifiedByAdminId: 'admin-1',
      rejectionReason: null,
    });
  });

  it('refuses to review the same document twice', async () => {
    const { service } = build({ foundDocument: document({ reviewStatus: 'approved' }) });

    await expect(
      service.reviewDocument(
        'document-1',
        { approved: false, rejectionReason: 'Changed my mind' },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'DOCUMENT_ALREADY_REVIEWED' },
    });
  });
});

/**
 * FR-19.7, and the client requirement it comes from: providers register on one
 * of TWO forms, doctor and non-doctor healthcare provider. The form is declared
 * by the specialty, and it decides three things - the credential list,
 * prescribing, and whether a medical council registration number is required.
 * This is the third.
 */
describe('the two registration forms', () => {
  const approvedDocs = REQUIRED.map((type) =>
    document({ documentType: type, reviewStatus: 'approved' }),
  );

  it('demands a council registration number on the DOCTOR form', async () => {
    // SRS section 8 makes confirming medical registration before listing the
    // client's obligation. A platform that signed off a psychiatrist with the
    // column empty would be quietly working against it.
    const { service } = build({
      documents: approvedDocs,
      requiresRegistrationNumber: true,
      doctor: {
        id: 'doctor-1',
        specialtyId: 'specialty-1',
        verificationStatus: 'under_review',
        registrationNumber: null,
      },
    });

    const progress = await service.progressOf('doctor-1');
    expect(progress.registrationNumberRequired).toBe(true);
    expect(progress.registrationNumberMissing).toBe(true);
    // Every document is approved, and it is still not ready.
    expect(progress.outstanding).toEqual([]);
    expect(progress.readyForVerification).toBe(false);
  });

  it('refuses verification, naming the field rather than the uploads', async () => {
    // An admin told only "credentials outstanding" would go hunting through
    // documents for something that is not there.
    const { service, doctorUpdate } = build({
      documents: approvedDocs,
      requiresRegistrationNumber: true,
      doctor: {
        id: 'doctor-1',
        specialtyId: 'specialty-1',
        verificationStatus: 'under_review',
        registrationNumber: null,
      },
    });

    await expect(service.verifyDoctor('doctor-1', ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CREDENTIALS_INCOMPLETE', details: { registrationNumberRequired: true } },
    });
    expect(doctorUpdate).not.toHaveBeenCalled();
  });

  it('does NOT demand one on the non-doctor form', async () => {
    // A counsellor or psychologist holds no council registration. Demanding one
    // would make that registration form impossible to complete.
    const { service } = build({
      documents: approvedDocs,
      requiresRegistrationNumber: false,
      doctor: {
        id: 'doctor-1',
        specialtyId: 'specialty-1',
        verificationStatus: 'under_review',
        registrationNumber: null,
      },
    });

    const progress = await service.progressOf('doctor-1');
    expect(progress.registrationNumberRequired).toBe(false);
    expect(progress.registrationNumberMissing).toBe(false);
    expect(progress.readyForVerification).toBe(true);
  });

  it('treats a blank registration number as no registration number', async () => {
    const { service } = build({
      documents: approvedDocs,
      requiresRegistrationNumber: true,
      doctor: {
        id: 'doctor-1',
        specialtyId: 'specialty-1',
        verificationStatus: 'under_review',
        registrationNumber: '   ',
      },
    });
    expect((await service.progressOf('doctor-1')).readyForVerification).toBe(false);
  });

  it('lets a doctor-form provider through once the number is on the row', async () => {
    const { service, doctorUpdate } = build({
      documents: approvedDocs,
      requiresRegistrationNumber: true,
    });
    await service.verifyDoctor('doctor-1', ADMIN);
    expect(doctorUpdate.mock.calls[0][0].data).toMatchObject({ verificationStatus: 'verified' });
  });
});

describe('DoctorVerificationService.verifyDoctor', () => {
  it('refuses while a required credential is outstanding, and says which', async () => {
    const { service, doctorUpdate } = build({
      required: ['degree_certificate', 'identity_proof'],
      documents: [document({ reviewStatus: 'approved' })],
    });

    await expect(service.verifyDoctor('doctor-1', ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CREDENTIALS_INCOMPLETE', details: { outstanding: ['identity_proof'] } },
    });
    expect(doctorUpdate).not.toHaveBeenCalled();
  });

  it('verifies once every required credential is approved, and does NOT list', async () => {
    const { service, doctorUpdate, publish } = build({
      required: ['degree_certificate'],
      documents: [document({ reviewStatus: 'approved' })],
    });

    await service.verifyDoctor('doctor-1', ADMIN);

    const data = doctorUpdate.mock.calls[0][0].data;
    expect(data.verificationStatus).toBe('verified');
    expect(data.verifiedByAdminId).toBe('admin-1');
    expect(data).not.toHaveProperty('isListed');
    expect(publish.mock.calls[0][0]).toBe('doctor.verified');
  });

  it('cannot be reached with an empty requirement list, because the baseline is never empty', async () => {
    // The port's default returns the configured baseline rather than [], so a
    // doctor who has uploaded nothing can never be signed off.
    const { service } = build({ required: REQUIRED, documents: [] });
    await expect(service.verifyDoctor('doctor-1', ADMIN)).rejects.toMatchObject({ status: 409 });
  });
});

describe('DoctorVerificationService.rejectDoctor', () => {
  it('keeps the admin’s reason on the row, so the doctor can read it when they sign in', async () => {
    const { service, doctorUpdate } = build();
    await service.rejectDoctor('doctor-1', 'Registration certificate is unreadable.', ADMIN);

    expect(doctorUpdate.mock.calls[0][0].data).toMatchObject({
      verificationStatus: 'rejected',
      isListed: false,
      rejectionReason: 'Registration certificate is unreadable.',
    });
  });

  it('tells the doctor, with the reason as the only variable', async () => {
    const { service, notify } = build();
    await service.rejectDoctor('doctor-1', 'ID does not match the name.', ADMIN);

    expect(notify).toHaveBeenCalledWith({
      code: 'doctor_rejected',
      to: { doctorId: 'doctor-1' },
      variables: { rejectionReason: 'ID does not match the name.' },
    });
  });

  it('reports the stored reason in the progress the doctor reads', async () => {
    const { service } = build({
      doctor: { id: 'doctor-1', specialtyId: 's', verificationStatus: 'rejected', registrationNumber: 'X', rejectionReason: 'Blurry ID.' },
    });
    expect((await service.progressOf('doctor-1')).rejectionReason).toBe('Blurry ID.');
  });

  it('clears the reason when the application is approved or reopened', async () => {
    const approved = build({ documents: REQUIRED.map((documentType) => document({ documentType, reviewStatus: 'approved' })) });
    await approved.service.verifyDoctor('doctor-1', ADMIN);
    expect(approved.doctorUpdate.mock.calls[0][0].data).toMatchObject({ verificationStatus: 'verified', rejectionReason: null });

    const reopened = build({
      doctor: { id: 'doctor-1', specialtyId: 's', verificationStatus: 'rejected', registrationNumber: 'X', rejectionReason: 'No.' },
    });
    await reopened.service.reopen('doctor-1', ADMIN);
    expect(reopened.doctorUpdate.mock.calls[0][0].data).toMatchObject({ verificationStatus: 'under_review', rejectionReason: null });
  });
});

describe('DoctorVerificationService.downloadUrl', () => {
  it("hides another doctor's credential rather than forbidding it", async () => {
    const { service } = build({ foundDocument: document({ doctorId: 'doctor-2' }) });
    await expect(service.downloadUrl('document-1', DOCTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('lets an admin read it, and writes an audit entry for the read', async () => {
    const { service, record, signDownload } = build();
    await service.downloadUrl('document-1', ADMIN);

    expect(signDownload).toHaveBeenCalledWith(
      'doctor-documents/doctor-1/degree_certificate/abc.pdf',
      'degree.pdf',
    );
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'read',
      entityType: 'doctor_document',
    });
  });

  it('refuses a patient outright', async () => {
    const { service } = build();
    await expect(
      service.downloadUrl('document-1', { type: 'patient', id: 'patient-1' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

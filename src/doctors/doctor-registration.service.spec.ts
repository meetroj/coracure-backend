import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DoctorRegistrationService, totalYears } from './doctor-registration.service';
import { SaveRegistrationDto } from './dto/doctor.dto';

type Row = Record<string, unknown>;

const stored = (over: Row = {}) => ({
  id: 'doctor-1',
  fullName: 'Dr Kavya Rao',
  verificationStatus: 'under_review',
  dateOfBirth: new Date('1990-08-04T00:00:00.000Z'),
  gender: 'female',
  email: 'kavya@example.com',
  registrationNumber: 'KMC-4471',
  rejectionReason: null,
  idType: 'aadhaar',
  idTypeName: null,
  idNumber: '4321 8765 1098',
  abhaId: null,
  basicQualification: 'BDS',
  pgSpecialisation: 'MDS Orthodontics',
  superSpecialisation: null,
  fellowship: null,
  experience: [{ id: 'e-1', designation: 'Consultant', institution: 'City Dental', years: new Prisma.Decimal(5.5), documentId: 'doc-exp' }],
  ...over,
});

/** The doctor's own uploads, as `doctor_documents` holds them. */
const OWN_DOCS = [
  { id: 'doc-degree', documentType: 'degree_certificate' },
  { id: 'doc-reg', documentType: 'registration_certificate' },
  { id: 'doc-exp', documentType: 'experience_letter' },
  { id: 'doc-sig', documentType: 'signature' },
];

const build = (row: Row = stored()) => {
  const findUnique = vi.fn().mockResolvedValue(row);
  const update = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const docFindMany = vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
    args.where.id ? OWN_DOCS.filter((d) => args.where.id!.in.includes(d.id)) : OWN_DOCS,
  );
  const tx = { doctor: { update }, doctorExperience: { deleteMany, createMany } };
  const prisma = {
    doctor: { findUnique },
    doctorDocument: { findMany: docFindMany },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  } as unknown as PrismaService;
  const record = vi.fn().mockResolvedValue(undefined);
  const notifyAdmins = vi.fn().mockResolvedValue(1);
  return {
    service: new DoctorRegistrationService(
      prisma,
      { record } as unknown as AuditService,
      { notifyAdmins } as unknown as NotificationsService,
    ),
    update,
    deleteMany,
    createMany,
    record,
    notifyAdmins,
  };
};

const full = (): SaveRegistrationDto => ({
  fullName: ' Kavya Rao ',
  dateOfBirth: '1990-08-04',
  gender: 'female',
  email: 'Kavya@Example.com',
  registrationNumber: ' KMC-4471 ',
  identity: { idType: 'aadhaar', idNumber: '4321 8765 1098', abhaId: '' },
  qualifications: {
    basicQualification: 'BDS',
    pgSpecialisation: 'MDS Orthodontics',
    superSpecialisation: '  ',
    degreeCertificateId: 'doc-degree',
    registrationCertificateId: 'doc-reg',
  },
  experience: [
    { designation: 'Resident', institution: 'Govt Dental College', years: 2.5, documentId: 'doc-exp' },
    { designation: 'Consultant', institution: 'City Dental', years: 5 },
  ],
  signatureDocumentId: 'doc-sig',
});

describe('DoctorRegistrationService', () => {
  it('never returns the ID number, only its last four characters', async () => {
    const view = await build().service.get('doctor-1');
    expect(view.identity).toEqual({ idType: 'aadhaar', idTypeName: null, numberLast4: '1098', abhaId: null });
    expect(JSON.stringify(view)).not.toContain('4321');
  });

  it('reads back the latest certificates, the signature and the summed experience', async () => {
    const view = await build().service.get('doctor-1');
    expect(view.dateOfBirth).toBe('1990-08-04');
    expect(view.qualifications).toMatchObject({ degreeCertificateId: 'doc-degree', registrationCertificateId: 'doc-reg' });
    expect(view.signatureDocumentId).toBe('doc-sig');
    expect(view.experience[0].years).toBe(5.5);
    expect(view.totalExperienceYears).toBe(5.5);
    expect(view.editable).toBe(true);
  });

  it('saves the facts and derives what a patient sees: names only, total years only', async () => {
    const { service, update, createMany } = build();
    await service.save('doctor-1', full());
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      fullName: 'Kavya Rao',
      email: 'kavya@example.com',
      registrationNumber: 'KMC-4471',
      basicQualification: 'BDS',
      superSpecialisation: null,
      abhaId: null,
      qualification: 'BDS · MDS Orthodontics',
      yearsOfExperience: 7,
    });
    expect(createMany.mock.calls[0][0].data.map((r: Row) => r.sortOrder)).toEqual([0, 1]);
  });

  it('replaces the experience list as a whole', async () => {
    const { service, deleteMany } = build();
    await service.save('doctor-1', { experience: [] });
    expect(deleteMany).toHaveBeenCalledWith({ where: { doctorId: 'doctor-1' } });
  });

  it('refuses a document that is not this doctor’s, or is the wrong type', async () => {
    await expect(build().service.save('doctor-1', { signatureDocumentId: 'someone-elses' })).rejects.toMatchObject({
      status: 404,
      response: { code: 'DOCUMENT_NOT_FOUND' },
    });
    // a real upload of this doctor, cited as the wrong thing
    await expect(
      build().service.save('doctor-1', { qualifications: { basicQualification: 'BDS', degreeCertificateId: 'doc-sig' } }),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_NOT_FOUND' } });
  });

  it('refuses an impossible date of birth', async () => {
    await expect(build().service.save('doctor-1', { dateOfBirth: '1990-02-30' })).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_FAILED' },
    });
  });

  it('is locked once an admin has verified the account', async () => {
    const { service, update } = build(stored({ verificationStatus: 'verified' }));
    await expect(service.save('doctor-1', full())).rejects.toMatchObject({ status: 409, response: { code: 'REGISTRATION_LOCKED' } });
    expect(update).not.toHaveBeenCalled();
    expect((await service.get('doctor-1')).editable).toBe(false);
  });

  it('never puts an ID number or date of birth in the audit row', async () => {
    const { service, record } = build();
    await service.save('doctor-1', full());
    expect(JSON.stringify(record.mock.calls[0][0])).not.toMatch(/4321|1990/);
  });

  it('tells the review team on every save, naming the provider', async () => {
    const { service, notifyAdmins } = build();
    await service.save('doctor-1', full());
    expect(notifyAdmins).toHaveBeenCalledWith(['clinical_governance', 'operations'], {
      code: 'doctor_application_submitted',
      variables: { doctorName: 'Kavya Rao' },
    });
  });

  it('falls back to a neutral name when the doctor has not given one yet', async () => {
    const { service, notifyAdmins } = build(stored({ fullName: '' }));
    await service.save('doctor-1', { registrationNumber: 'KMC-1' });
    expect(notifyAdmins.mock.calls[0][1].variables.doctorName).toBe('A new provider');
  });

  it('a rejected doctor’s save is a resubmission: back under review, reason cleared', async () => {
    const { service, update } = build(stored({ verificationStatus: 'rejected', rejectionReason: 'ID unreadable' }));
    await service.save('doctor-1', full());
    expect(update.mock.calls[0][0].data).toMatchObject({ verificationStatus: 'under_review', rejectionReason: null });
  });

  it('a save by a doctor already under review does not change their status', async () => {
    const { service, update } = build();
    await service.save('doctor-1', full());
    expect(update.mock.calls[0][0].data).not.toHaveProperty('verificationStatus');
  });

  it('refuses a registration number that is already on another account', async () => {
    const { service, update } = build();
    update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(service.save('doctor-1', full())).rejects.toMatchObject({
      status: 409,
      response: { code: 'DOCTOR_ALREADY_EXISTS' },
    });
  });

  it('tells nobody when the save was refused', async () => {
    const { service, notifyAdmins } = build(stored({ verificationStatus: 'verified' }));
    await service.save('doctor-1', full()).catch(() => undefined);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('sums years to one decimal', () => {
    expect(totalYears([2.5, 0.2, 0.1])).toBe(2.8);
  });
});

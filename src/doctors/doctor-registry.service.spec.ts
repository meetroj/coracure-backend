import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { EventBus } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { AccountsService } from '../identity/accounts.service';
import { PatientAssignment } from '../patients/patient-assignment';
import { CredentialStorage } from './credential-storage';
import { DoctorMetrics } from './doctor-metrics';
import { DoctorRegistryService } from './doctor-registry.service';
import { SpecialtyCatalogue } from './specialty-catalogue';

type Row = Record<string, unknown>;

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

const doctor = (over: Row = {}) => ({
  id: 'doctor-1',
  mobileNumber: '+919812345678',
  mobileVerifiedAt: null,
  fullName: 'Dr Meera Iyer',
  bio: null,
  languages: ['en', 'hi'],
  verificationStatus: 'verified',
  registrationNumber: 'KMC/12345',
  qualification: 'MBBS, MD',
  yearsOfExperience: 12,
  verifiedByAdminId: 'admin-1',
  verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
  seniorityLevel: 'standard',
  specialtyId: 'specialty-1',
  consultationFeeInr: new Prisma.Decimal(800),
  consultationDurationMinutes: 30,
  bufferMinutes: 5,
  isListed: true,
  allowInstantConsult: false,
  bankVerified: false,
  presence: 'offline',
  blockedByConsultationId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  ...over,
});

function build(
  over: { row?: Row | null; canPrescribe?: boolean; rows?: Row[]; treating?: boolean } = {},
) {
  const found = over.row === undefined ? doctor() : over.row;
  const findUnique = vi.fn().mockResolvedValue(found);
  const findMany = vi
    .fn<(args: { where: Row; orderBy: unknown }) => Promise<Row[]>>()
    .mockResolvedValue((over.rows ?? [found].filter(Boolean)) as Row[]);
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...(found as Row), ...args.data }));
  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...doctor(), ...args.data }));
  const deleteMany = vi
    .fn<(args: { where: Row }) => Promise<Row>>()
    .mockResolvedValue({ count: 0 });
  const createMany = vi
    .fn<(args: { data: Row[]; skipDuplicates?: boolean }) => Promise<Row>>()
    .mockResolvedValue({ count: 0 });
  const regionFindMany = vi.fn().mockResolvedValue([{ regionId: 'region-1' }]);
  const photoFindFirst = vi.fn().mockResolvedValue(null);
  const prisma = {
    doctor: { findUnique, findMany, update, create },
    doctorRegion: { deleteMany, createMany, findMany: regionFindMany },
    doctorDocument: { findFirst: photoFindFirst },
    $transaction: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const publish = vi.fn<(event: string, payload: Row) => void>();
  const revokeAllTokens = vi.fn().mockResolvedValue(undefined);
  const canPrescribe = vi.fn().mockResolvedValue(over.canPrescribe ?? false);
  const patientFeeInr = vi.fn().mockResolvedValue(1200);
  const catalogue = {
    canPrescribe,
    patientFeeInr,
    requiredDocuments: vi.fn().mockResolvedValue([]),
  } as unknown as SpecialtyCatalogue;
  const isDoctorTreating = vi.fn().mockResolvedValue(over.treating ?? false);
  const assignment = { isDoctorTreating } as unknown as PatientAssignment;
  const metrics = {
    reliabilityOf: vi.fn().mockResolvedValue({
      acceptanceRate: null,
      noShowRate: null,
      caseSummaryCompletion: null,
      consultationsCompleted: 0,
    }),
  } as unknown as DoctorMetrics;
  const signDownload = vi.fn().mockResolvedValue({ url: 'https://signed.example/photo', expiresInSeconds: 300 });
  const credentials = { signDownload } as unknown as CredentialStorage;

  return {
    service: new DoctorRegistryService(
      prisma,
      { record } as unknown as AuditService,
      { publish } as unknown as EventBus,
      { revokeAllTokens } as unknown as AccountsService,
      catalogue,
      metrics,
      assignment,
      credentials,
    ),
    findMany,
    deleteMany,
    createMany,
    isDoctorTreating,
    patientFeeInr,
    update,
    create,
    record,
    publish,
    photoFindFirst,
    revokeAllTokens,
    canPrescribe,
  };
}

describe('DoctorRegistryService.create', () => {
  it('turns a duplicate mobile number into a conflict, not a 500', async () => {
    const { service, create } = build();
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
        meta: { target: ['mobile_number'] },
      }),
    );

    await expect(
      service.create({ mobileNumber: '+919812345678', fullName: 'Dr Meera Iyer' }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records who created the account, because there is no created_by column', async () => {
    const { service, record, publish } = build();
    await service.create({ mobileNumber: '+919812345678', fullName: 'Dr Meera Iyer' }, ADMIN);

    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'create',
      entityType: 'doctor',
      actorId: 'admin-1',
    });
    expect(publish.mock.calls[0]).toMatchObject([
      'doctor.created',
      { createdByAdminId: 'admin-1' },
    ]);
  });
});

describe('DoctorRegistryService listing rules', () => {
  it('refuses to list a doctor who is not verified', async () => {
    const { service, update } = build({
      row: doctor({ verificationStatus: 'under_review', isListed: false }),
    });

    await expect(service.setListed('doctor-1', true, ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'DOCTOR_NOT_VERIFIED' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('delists a verified doctor without touching their verification', async () => {
    const { service, update } = build();
    await service.setListed('doctor-1', false, ADMIN);
    expect(update.mock.calls[0][0].data).toEqual({ isListed: false });
  });

  it('404s a provider the patient is not assigned to, rather than 403ing', async () => {
    // A 403 would confirm the id belongs to a real provider.
    const { service } = build({ treating: false });
    await expect(service.getAssignedListing('doctor-1', 'patient-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('shows the assigned provider, priced by the SERVICE not the provider', async () => {
    const { service, patientFeeInr } = build({ treating: true });
    const listing = await service.getAssignedListing('doctor-1', 'patient-1');

    // 1200 is the specialty fee; 800 is what this provider is paid.
    expect(listing.consultationFeeInr).toBe(1200);
    expect(patientFeeInr).toHaveBeenCalledWith('specialty-1');
  });

  it('refuses booking a doctor who is verified but not listed', async () => {
    const { service } = build({ row: doctor({ isListed: false }) });
    await expect(service.assertBookable('doctor-1')).rejects.toMatchObject({
      response: { code: 'DOCTOR_NOT_VERIFIED' },
    });
  });

  it('has no patient-facing directory at all', () => {
    const { service } = build();
    // SRS 1.2 removed provider browsing. If this ever comes back, it comes back
    // as a deliberate decision, not as a method somebody quietly re-added.
    expect(service).not.toHaveProperty('listBookable');
  });

  it('filters the ADMIN roster by region pool', async () => {
    const { service, findMany } = build();
    await service.listForAdmin({ regionId: 'region-1', language: 'hi' });

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      regions: { some: { regionId: 'region-1' } },
      languages: { array_contains: ['hi'] },
    });
  });
});

describe('DoctorRegistryService.suspend', () => {
  it('delists, goes offline and signs the doctor out of every device', async () => {
    const { service, update, revokeAllTokens, publish } = build();
    await service.suspend('doctor-1', 'Registration lapsed', ADMIN);

    expect(update.mock.calls[0][0].data).toEqual({
      verificationStatus: 'suspended',
      isListed: false,
      presence: 'offline',
    });
    expect(revokeAllTokens).toHaveBeenCalledWith({ type: 'doctor', id: 'doctor-1' });
    expect(publish).toHaveBeenCalledWith('doctor.suspended', expect.anything());
  });

  it('does not delete the row - the clinical record hangs off it', async () => {
    const { service } = build();
    const suspended = await service.suspend('doctor-1', 'Under investigation', ADMIN);
    expect(suspended.id).toBe('doctor-1');
    expect(suspended.verificationStatus).toBe('suspended');
  });
});

describe('DoctorRegistryService.reinstate', () => {
  it('returns a previously verified doctor to verified, but not to listed', async () => {
    const { service, update } = build({
      row: doctor({ verificationStatus: 'suspended', isListed: false }),
    });
    await service.reinstate('doctor-1', ADMIN);

    expect(update.mock.calls[0][0].data).toEqual({ verificationStatus: 'verified' });
  });

  it('returns a doctor who was never verified to pending', async () => {
    const { service, update } = build({
      row: doctor({ verificationStatus: 'suspended', isListed: false, verifiedAt: null }),
    });
    await service.reinstate('doctor-1', ADMIN);

    expect(update.mock.calls[0][0].data).toEqual({ verificationStatus: 'pending' });
  });

  it('refuses to reinstate a doctor who is not suspended', async () => {
    const { service } = build();
    await expect(service.reinstate('doctor-1', ADMIN)).rejects.toMatchObject({ status: 409 });
  });
});

describe('DoctorRegistryService profile edits', () => {
  it('lets a doctor change their bio but never their fee', async () => {
    const { service, update } = build();
    await service.updateSelf('doctor-1', {
      bio: 'Fifteen years in community psychiatry.',
      // @ts-expect-error the fee is not part of DoctorSelfPatch, and must not slip through
      consultationFeeInr: 1,
    });

    expect(update.mock.calls[0][0].data).toEqual({ bio: 'Fifteen years in community psychiatry.' });
  });

  it('records a payout change with its value, not just the field name', async () => {
    const { service, record } = build();
    await service.updateAsAdmin('doctor-1', { payoutFeeInr: 1200 }, ADMIN);

    expect(record.mock.calls[0][0]).toMatchObject({ metadata: { payoutFeeInr: 1200 } });
  });
});

describe('DoctorRegistryService.canPrescribe', () => {
  it('asks the specialty, never the doctor row', async () => {
    const { service, canPrescribe } = build({ canPrescribe: true });
    await expect(service.canPrescribe('doctor-1')).resolves.toBe(true);
    expect(canPrescribe).toHaveBeenCalledWith('specialty-1');
  });

  it('refuses while no catalogue can answer, rather than allowing', async () => {
    const { service } = build();
    await expect(service.canPrescribe('doctor-1')).resolves.toBe(false);
  });
});

describe('DoctorRegistryService.setSeniority', () => {
  it('grants expert level and records what it changed from', async () => {
    const { service, update, record } = build();
    await service.setSeniority('doctor-1', 'expert', ADMIN);

    expect(update.mock.calls[0][0].data).toEqual({ seniorityLevel: 'expert' });
    expect(record.mock.calls[0][0]).toMatchObject({ metadata: { from: 'standard', to: 'expert' } });
  });
});

describe('DoctorRegistryService.setRegions', () => {
  it('replaces the whole pool in one transaction', async () => {
    const { service, deleteMany, createMany } = build();
    await service.setRegions('doctor-1', ['region-1', 'region-2'], ADMIN);

    // Everything NOT in the new set goes, and the new set is added. A
    // half-applied edit cannot leave a provider in a region they left.
    expect(deleteMany.mock.calls[0][0].where).toMatchObject({
      doctorId: 'doctor-1',
      regionId: { notIn: ['region-1', 'region-2'] },
    });
    expect(createMany.mock.calls[0][0].data).toEqual([
      { doctorId: 'doctor-1', regionId: 'region-1' },
      { doctorId: 'doctor-1', regionId: 'region-2' },
    ]);
  });

  it('clearing the pool removes every row rather than none', async () => {
    const { service, deleteMany } = build();
    await service.setRegions('doctor-1', [], ADMIN);
    expect(deleteMany.mock.calls[0][0].where).toEqual({ doctorId: 'doctor-1' });
  });

  it('records the regions themselves - they decide who can reach this provider', async () => {
    const { service, record } = build();
    await service.setRegions('doctor-1', ['region-1'], ADMIN);

    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'doctor_regions',
      metadata: { regionIds: ['region-1'] },
    });
  });

  it('de-duplicates a region sent twice', async () => {
    const { service, createMany } = build();
    await service.setRegions('doctor-1', ['region-1', 'region-1'], ADMIN);
    expect(createMany.mock.calls[0][0].data).toEqual([
      { doctorId: 'doctor-1', regionId: 'region-1' },
    ]);
  });
});

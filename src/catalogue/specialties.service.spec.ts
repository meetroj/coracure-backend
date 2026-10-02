import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { AllocationPolicyService } from './allocation-policy.service';
import { AppConfigService } from '../app-config/app-config.service';
import { SpecialtiesService } from './specialties.service';

type Row = Record<string, unknown>;

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'content' };

const specialty = (over: Row = {}) => ({
  id: 'specialty-1',
  code: 'psychiatry',
  name: 'Psychiatry',
  description: null,
  providerType: 'doctor',
  canPrescribe: true,
  consultationFeeInr: new Prisma.Decimal(800),
  intakeForm: null,
  firstConsultForm: null,
  requiredDocuments: [],
  isActive: true,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
});

function build(over: { row?: Row | null; listedProviders?: number } = {}) {
  const found = over.row === undefined ? specialty() : over.row;
  const findUnique = vi.fn().mockResolvedValue(found);
  const findMany = vi.fn().mockResolvedValue([found].filter(Boolean));
  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...specialty(), ...args.data }));
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...(found as Row), ...args.data }));
  const count = vi.fn().mockResolvedValue(over.listedProviders ?? 0);
  const prisma = {
    specialty: { findUnique, findMany, create, update },
    doctor: { count },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  return {
    service: new SpecialtiesService(prisma, { record } as unknown as AuditService),
    create,
    update,
    record,
  };
}

describe('SpecialtiesService prescribing rule', () => {
  it('*** refuses a non-doctor specialty that claims to prescribe ***', async () => {
    // This is the line between a psychiatrist and a psychologist. A CHECK
    // enforces it too; this is so the admin gets a sentence, not a 500.
    const { service, create } = build();
    await expect(
      service.create(
        {
          code: 'counselling',
          name: 'Counselling',
          providerType: 'non_doctor',
          canPrescribe: true,
          consultationFeeInr: 500,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'ONLY_DOCTORS_PRESCRIBE' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to demote a prescribing specialty to non-doctor and leave the right standing', async () => {
    const { service, update } = build();
    await expect(
      service.update('specialty-1', { providerType: 'non_doctor' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'ONLY_DOCTORS_PRESCRIBE' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('allows the demotion when prescribing is dropped in the same edit', async () => {
    const { service, update } = build();
    await service.update('specialty-1', { providerType: 'non_doctor', canPrescribe: false }, ADMIN);
    expect(update.mock.calls[0][0].data).toMatchObject({
      providerType: 'non_doctor',
      canPrescribe: false,
    });
  });

  it('lets a doctor specialty exist without prescribing rights', async () => {
    const { service, create } = build();
    await service.create(
      { code: 'general', name: 'General', providerType: 'doctor', consultationFeeInr: 400 },
      ADMIN,
    );
    expect(create).toHaveBeenCalled();
  });
});

describe('SpecialtiesService fees', () => {
  it('records a fee change from and to, because it is money', async () => {
    const { service, record } = build();
    await service.update('specialty-1', { consultationFeeInr: 950 }, ADMIN);

    expect(record.mock.calls[0][0]).toMatchObject({
      metadata: { feeInr: { from: 800, to: 950 } },
    });
  });

  it('exposes the fee to a patient as the price of the SERVICE', async () => {
    const { service } = build();
    const [listed] = await service.listServices();
    expect(listed.consultationFeeInr).toBe(800);
    expect(listed).not.toHaveProperty('doctorId');
  });
});

describe('SpecialtiesService retirement', () => {
  it('refuses to disable a specialty that listed providers are registered under', async () => {
    const { service, update } = build({ listedProviders: 3 });
    await expect(service.update('specialty-1', { isActive: false }, ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'STILL_IN_USE' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('disables one nobody is listed under', async () => {
    const { service, update } = build({ listedProviders: 0 });
    await service.update('specialty-1', { isActive: false }, ADMIN);
    expect(update.mock.calls[0][0].data).toMatchObject({ isActive: false });
  });

  it('never deletes - consultations point at it', () => {
    const { service } = build();
    expect(service).not.toHaveProperty('delete');
  });
});

describe('SpecialtiesService codes', () => {
  it('turns a duplicate code into a conflict an admin can act on', async () => {
    const { service, create } = build();
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
        meta: { target: ['code'] },
      }),
    );
    await expect(
      service.create(
        { code: 'psychiatry', name: 'Psychiatry', providerType: 'doctor', consultationFeeInr: 800 },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: 'CODE_ALREADY_EXISTS' } });
  });
});

describe('AllocationPolicyService', () => {
  function policyWith(stored?: Record<string, unknown>) {
    const get = vi.fn().mockResolvedValue(stored);
    const set = vi.fn().mockResolvedValue(undefined);
    return {
      policy: new AllocationPolicyService({ get, set } as unknown as AppConfigService),
      set,
    };
  }

  it('load-balances by default, so work spreads across the pool', async () => {
    const { policy } = policyWith();
    await expect(policy.current()).resolves.toMatchObject({ tieBreak: 'fewest_upcoming' });
  });

  it('treats region as relaxable by default, so a thin pool never blocks a booking', async () => {
    const { policy } = policyWith();
    await expect(policy.current()).resolves.toMatchObject({ regionRelaxable: true });
  });

  it('fills in a flag a stored policy predates', async () => {
    const { policy } = policyWith({ tieBreak: 'longest_free' });
    await expect(policy.current()).resolves.toEqual({
      tieBreak: 'longest_free',
      regionRelaxable: true,
      maxPatientDeclines: 2,
    });
  });

  it('*** offers no way to relax the language requirement ***', async () => {
    // FR-20.4 is not an admin setting. A provider who cannot speak to the
    // patient is never assigned, and no stored policy can change that.
    const { policy } = policyWith();
    const current = await policy.current();
    expect(Object.keys(current)).not.toContain('languageRelaxable');
  });

  it('merges an edit onto what is in force rather than replacing it', async () => {
    const { policy, set } = policyWith({ maxPatientDeclines: 5 });
    await policy.update({ regionRelaxable: false }, ADMIN);

    expect(set.mock.calls[0][1]).toEqual({
      regionRelaxable: false,
      tieBreak: 'fewest_upcoming',
      maxPatientDeclines: 5,
    });
  });
});

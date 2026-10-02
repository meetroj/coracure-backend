import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../database/prisma.service';
import { AccountsService } from './accounts.service';

const patientRow = (over: Record<string, unknown> = {}) => ({
  id: 'patient-1',
  status: 'active',
  tokenVersion: 2,
  ...over,
});

function serviceWith(over: Record<string, unknown> = {}) {
  const prisma = {
    patient: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    doctor: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    admin: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    ...over,
  } as unknown as PrismaService;
  return { service: new AccountsService(prisma), prisma };
}

describe('AccountsService', () => {
  it('resolves a patient whose token version still matches', async () => {
    const { service } = serviceWith({
      patient: { findUnique: vi.fn().mockResolvedValue(patientRow()), update: vi.fn() },
    });
    await expect(service.resolve({ sub: 'patient-1', typ: 'patient', ver: 2 })).resolves.toEqual({
      type: 'patient',
      id: 'patient-1',
    });
  });

  it('*** REVOCATION *** refuses a token issued before the version moved', async () => {
    const { service } = serviceWith({
      patient: { findUnique: vi.fn().mockResolvedValue(patientRow({ tokenVersion: 3 })), update: vi.fn() },
    });
    await expect(service.resolve({ sub: 'patient-1', typ: 'patient', ver: 2 })).resolves.toBeNull();
  });

  it('resolves nothing for an account that no longer exists', async () => {
    const { service } = serviceWith();
    await expect(service.resolve({ sub: 'gone', typ: 'patient', ver: 0 })).resolves.toBeNull();
  });

  it.each([['suspended'], ['deleted']])('refuses a %s account', async (status) => {
    const { service } = serviceWith({
      patient: { findUnique: vi.fn().mockResolvedValue(patientRow({ status })), update: vi.fn() },
    });
    await expect(service.resolve({ sub: 'patient-1', typ: 'patient', ver: 2 })).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  });

  it('lets a pending patient sign in, because the profile is filled in afterwards', async () => {
    const { service } = serviceWith({
      patient: { findUnique: vi.fn().mockResolvedValue(patientRow({ status: 'pending' })), update: vi.fn() },
    });
    await expect(service.resolve({ sub: 'patient-1', typ: 'patient', ver: 2 })).resolves.toMatchObject({
      type: 'patient',
    });
  });

  it('carries the permission level for an admin', async () => {
    const { service } = serviceWith({
      admin: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'admin-1', status: 'active', tokenVersion: 0, permissionLevel: 'finance' }),
        update: vi.fn(),
      },
    });
    await expect(service.resolve({ sub: 'admin-1', typ: 'admin', ver: 0 })).resolves.toEqual({
      type: 'admin',
      id: 'admin-1',
      level: 'finance',
    });
  });

  it('resolves a doctor from the row M-05 owns', async () => {
    const { service } = serviceWith({
      doctor: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'doctor-1', verificationStatus: 'verified', tokenVersion: 1 }),
        update: vi.fn(),
      },
    });
    await expect(service.resolve({ sub: 'doctor-1', typ: 'doctor', ver: 1 })).resolves.toEqual({
      type: 'doctor',
      id: 'doctor-1',
    });
  });

  it('resolves an unverified doctor, because uploading credentials needs a session', async () => {
    const { service } = serviceWith({
      doctor: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'doctor-1', verificationStatus: 'under_review', tokenVersion: 0 }),
        update: vi.fn(),
      },
    });
    await expect(service.resolve({ sub: 'doctor-1', typ: 'doctor', ver: 0 })).resolves.toMatchObject({
      type: 'doctor',
    });
  });

  it('refuses a suspended doctor', async () => {
    const { service } = serviceWith({
      doctor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'doctor-1', verificationStatus: 'suspended', tokenVersion: 0 }),
        update: vi.fn(),
      },
    });
    await expect(service.resolve({ sub: 'doctor-1', typ: 'doctor', ver: 0 })).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  });

  it('keeps a rejected doctor signed in: they read the reason and resubmit', async () => {
    const { service } = serviceWith({
      doctor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'doctor-1', verificationStatus: 'rejected', tokenVersion: 0 }),
        update: vi.fn(),
      },
    });
    await expect(service.resolve({ sub: 'doctor-1', typ: 'doctor', ver: 0 })).resolves.toMatchObject({ type: 'doctor' });
  });

  it('signing a doctor out bumps the version and clears their push token', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { service } = serviceWith({ doctor: { findUnique: vi.fn(), update } });

    await service.revokeAllTokens({ type: 'doctor', id: 'doctor-1' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'doctor-1' },
      data: { tokenVersion: { increment: 1 }, pushToken: null, deviceId: null },
    });
  });

  it('signing out bumps the version and stops push delivery (FR-1.8)', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { service } = serviceWith({ patient: { findUnique: vi.fn(), update } });

    await service.revokeAllTokens({ type: 'patient', id: 'patient-1' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'patient-1' },
      data: { tokenVersion: { increment: 1 }, pushToken: null, deviceId: null },
    });
  });

  it('signing an admin out touches no push token, because admins have none', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { service } = serviceWith({ admin: { findUnique: vi.fn(), update } });

    await service.revokeAllTokens({ type: 'admin', id: 'admin-1' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: { tokenVersion: { increment: 1 } },
    });
  });
});

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { VerifiedDoctorGuard } from './doctor-access';

function contextFor(actor?: AuthenticatedActor): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ actor }) }),
  } as unknown as ExecutionContext;
}

function build(over: { required?: boolean; status?: string | null } = {}) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(over.required ?? true),
  } as unknown as Reflector;
  const findUnique = vi
    .fn()
    .mockResolvedValue(
      over.status === null ? null : { verificationStatus: over.status ?? 'verified' },
    );
  const prisma = { doctor: { findUnique } } as unknown as PrismaService;
  return { guard: new VerifiedDoctorGuard(reflector, prisma), findUnique };
}

const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };

describe('VerifiedDoctorGuard', () => {
  it('lets a verified doctor through', async () => {
    const { guard } = build();
    await expect(guard.canActivate(contextFor(DOCTOR))).resolves.toBe(true);
  });

  it('refuses a doctor who is still under review, and says what to do', async () => {
    const { guard } = build({ status: 'under_review' });
    await expect(guard.canActivate(contextFor(DOCTOR))).rejects.toMatchObject({
      status: 403,
      response: { code: 'DOCTOR_NOT_APPROVED' },
    });
  });

  it('refuses a suspended doctor even while their token is still valid', async () => {
    const { guard } = build({ status: 'suspended' });
    await expect(guard.canActivate(contextFor(DOCTOR))).rejects.toMatchObject({ status: 403 });
  });

  it('reads the row, not the token, so revoking approval bites immediately', async () => {
    const { guard, findUnique } = build();
    await guard.canActivate(contextFor(DOCTOR));
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'doctor-1' },
      select: { verificationStatus: true },
    });
  });

  it('leaves routes without the decorator alone', async () => {
    const { guard, findUnique } = build({ required: false, status: 'pending' });
    await expect(guard.canActivate(contextFor(DOCTOR))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not judge an admin - @Roles decides that', async () => {
    const { guard, findUnique } = build();
    await expect(
      guard.canActivate(contextFor({ type: 'admin', id: 'admin-1', level: 'operations' })),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

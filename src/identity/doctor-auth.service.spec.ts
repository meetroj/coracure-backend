import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AccountsService } from './accounts.service';
import { DoctorAuthService } from './doctor-auth.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OtpProvider } from './otp/otp.provider';
import { TokensService } from './tokens.service';

type Row = Record<string, unknown>;

const SECRET = 'x'.repeat(32);
const ENVIRONMENT = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: SECRET,
};

const CONTEXT = { ipAddress: '203.0.113.4', userAgent: 'CoracureDoctor/1.0' };

const doctor = (over: Row = {}) => ({
  id: 'doctor-1',
  verificationStatus: 'under_review',
  tokenVersion: 0,
  mobileVerifiedAt: null,
  ...over,
});

/** `row: null` is a number nobody has used yet - the start of a sign-up. */
function build(over: { row?: Row | null; codeAccepted?: boolean } = {}) {
  const found = over.row === undefined ? doctor() : over.row;
  const findUnique = vi.fn().mockResolvedValue(found);
  const upsert = vi
    .fn<(args: { where: Row; create: Row; update: Row }) => Promise<Row>>()
    .mockImplementation((args) =>
      Promise.resolve(found ? { ...found, ...args.update } : { ...doctor({ verificationStatus: 'pending' }), ...args.create }),
    );
  const prisma = { doctor: { findUnique, upsert } } as unknown as PrismaService;

  const request = vi.fn().mockResolvedValue({ challengeId: 'challenge-1' });
  const verify = vi.fn().mockResolvedValue(over.codeAccepted ?? true);
  const otp = { request, verify } as unknown as OtpProvider;

  const assertWithinLimit = vi.fn().mockResolvedValue(undefined);
  const assertIpWithinLimit = vi.fn().mockResolvedValue(undefined);
  const record = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const rateLimit = { assertWithinLimit, assertIpWithinLimit, record } as unknown as LoginRateLimitService;

  const auditRecord = vi.fn().mockResolvedValue(undefined);

  return {
    service: new DoctorAuthService(
      prisma,
      new AccountsService(prisma),
      new TokensService(new JwtService({ secret: SECRET })),
      rateLimit,
      { record: auditRecord } as unknown as AuditService,
      otp,
    ),
    upsert,
    request,
    assertWithinLimit,
    assertIpWithinLimit,
    record,
    auditRecord,
  };
}

describe('DoctorAuthService.requestOtp', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({ ...ENVIRONMENT });
  });

  it('sends a code to a number nobody has used yet - that is how sign-up starts', async () => {
    const { service, request } = build({ row: null });

    await expect(service.requestOtp('+919812345678', CONTEXT)).resolves.toEqual({ challengeId: 'challenge-1' });
    expect(request).toHaveBeenCalledWith('+919812345678', 'doctor_signin');
  });

  it('answers a new number exactly as it answers a known one', async () => {
    const fresh = await build({ row: null }).service.requestOtp('+919812345678', CONTEXT);
    const known = await build().service.requestOtp('+919812345678', CONTEXT);
    expect(fresh).toEqual(known);
  });

  it('sends a code to a doctor who is still awaiting verification', async () => {
    const { service, request } = build();
    await expect(service.requestOtp('+919812345678', CONTEXT)).resolves.toEqual({
      challengeId: 'challenge-1',
    });
    expect(request).toHaveBeenCalledWith('+919812345678', 'doctor_signin');
  });

  it('refuses a suspended doctor', async () => {
    const { service } = build({ row: doctor({ verificationStatus: 'suspended' }) });
    await expect(service.requestOtp('+919812345678', CONTEXT)).rejects.toMatchObject({
      status: 403,
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  });

  it('lets a rejected doctor in - they sign in to read the reason and resubmit', async () => {
    const { service, request } = build({ row: doctor({ verificationStatus: 'rejected' }) });
    await expect(service.requestOtp('+919812345678', CONTEXT)).resolves.toEqual({ challengeId: 'challenge-1' });
    expect(request).toHaveBeenCalled();
  });

  it('checks the per-number AND the per-address limit before sending anything', async () => {
    const { service, assertWithinLimit, assertIpWithinLimit, request } = build({ row: null });
    await service.requestOtp('+919812345678', CONTEXT);
    expect(assertWithinLimit).toHaveBeenCalledWith('doctor_otp_request', '+919812345678');
    expect(assertIpWithinLimit).toHaveBeenCalledWith('203.0.113.4');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when one address has asked for too many codes', async () => {
    const built = build({ row: null });
    built.assertIpWithinLimit.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }));
    await expect(built.service.requestOtp('+919812345678', CONTEXT)).rejects.toMatchObject({ status: 429 });
    expect(built.request).not.toHaveBeenCalled();
  });
});

describe('DoctorAuthService.verifyOtp', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({ ...ENVIRONMENT });
  });

  const input = {
    mobileNumber: '+919812345678',
    challengeId: 'challenge-1',
    code: '000000',
  };

  it('creates the account on the first verified code, blank and already number-verified', async () => {
    const { service, upsert, auditRecord } = build({ row: null });
    const result = await service.verifyOtp(input, CONTEXT);

    const create = upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ mobileNumber: '+919812345678', fullName: '' });
    expect(create.mobileVerifiedAt).toBeInstanceOf(Date);
    expect(result.isNewAccount).toBe(true);
    expect(result.verificationStatus).toBe('pending');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'system', action: 'create', entityType: 'doctor', metadata: { via: 'otp_signup' } }),
    );
  });

  it('never creates a row on a wrong code', async () => {
    const { service, upsert, auditRecord } = build({ row: null, codeAccepted: false });
    await expect(service.verifyOtp(input, CONTEXT)).rejects.toMatchObject({ status: 401 });
    expect(upsert).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('stamps mobile_verified_at the first time somebody proves they hold the number', async () => {
    const { service, upsert } = build();
    await service.verifyOtp(input, CONTEXT);

    expect(upsert.mock.calls[0][0].update).toHaveProperty('mobileVerifiedAt');
  });

  it('does not restamp it on a later sign-in, and does not call it a new account', async () => {
    const { service, upsert, auditRecord } = build({
      row: doctor({ mobileVerifiedAt: new Date('2026-08-01T00:00:00.000Z') }),
    });
    const result = await service.verifyOtp({ ...input, deviceId: 'device-9' }, CONTEXT);

    expect(upsert.mock.calls[0][0].update).toEqual({ deviceId: 'device-9' });
    expect(result.isNewAccount).toBe(false);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('hands back the verification status the app routes on', async () => {
    const { service } = build();
    const result = await service.verifyOtp(input, CONTEXT);

    expect(result.verificationStatus).toBe('under_review');
    expect(result.accessToken).toBeTruthy();
  });

  it('signs a rejected doctor in, with that status, so the app can show the reason', async () => {
    const { service } = build({ row: doctor({ verificationStatus: 'rejected' }) });
    const result = await service.verifyOtp(input, CONTEXT);
    expect(result.verificationStatus).toBe('rejected');
  });

  it('refuses a suspended doctor before checking the code', async () => {
    const { service } = build({ row: doctor({ verificationStatus: 'suspended' }) });
    await expect(service.verifyOtp(input, CONTEXT)).rejects.toMatchObject({
      status: 403,
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  });

  it('refuses a wrong code without touching the row', async () => {
    const { service, upsert } = build({ codeAccepted: false });
    await expect(service.verifyOtp(input, CONTEXT)).rejects.toMatchObject({ status: 401 });
    expect(upsert).not.toHaveBeenCalled();
  });
});

import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AccountsService } from './accounts.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OtpProvider } from './otp/otp.provider';
import { PatientAuthService } from './patient-auth.service';
import { TokensService } from './tokens.service';

const SECRET = 'x'.repeat(32);
const MOBILE = '+919876543210';

function build(over: {
  existing?: Record<string, unknown> | null;
  otpValid?: boolean;
  limitReached?: boolean;
} = {}) {
  type UpsertArgs = {
    where: { mobileNumber: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };
  const findUnique = vi.fn().mockResolvedValue(over.existing ?? null);
  const upsert = vi
    .fn<(args: UpsertArgs) => Promise<{ id: string; status: string; tokenVersion: number }>>()
    .mockResolvedValue({ id: 'patient-1', status: 'active', tokenVersion: 0 });
  const prisma = { patient: { findUnique, upsert, update: vi.fn() } } as unknown as PrismaService;

  const record = vi.fn().mockResolvedValue(undefined);
  const assertWithinLimit = over.limitReached
    ? vi.fn().mockRejectedValue(Object.assign(new Error('limit'), { code: 'TOO_MANY_ATTEMPTS' }))
    : vi.fn().mockResolvedValue(undefined);
  const rateLimit = { assertWithinLimit, record } as unknown as LoginRateLimitService;

  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const otpRequest = vi
    .fn<OtpProvider['request']>()
    .mockResolvedValue({ challengeId: 'challenge-1' });
  const otpVerify = vi.fn<OtpProvider['verify']>().mockResolvedValue(over.otpValid ?? true);
  const otp: OtpProvider = { request: otpRequest, verify: otpVerify };

  const service = new PatientAuthService(
    prisma,
    new AccountsService(prisma),
    new TokensService(new JwtService({ secret: SECRET })),
    rateLimit,
    { record: auditRecord } as unknown as AuditService,
    otp,
  );
  return { service, findUnique, upsert, otpRequest, otpVerify, assertWithinLimit, record, auditRecord };
}

describe('PatientAuthService', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: SECRET,
    });
  });

  it('asks the provider for a code and returns only the challenge handle', async () => {
    const { service, otpRequest } = build();
    await expect(service.requestOtp(MOBILE, {})).resolves.toEqual({ challengeId: 'challenge-1' });
    expect(otpRequest).toHaveBeenCalledWith(MOBILE, 'patient_signin');
  });

  it('answers a new and an existing number identically, so it is not a registration oracle', async () => {
    const unknown = await build({ existing: null }).service.requestOtp(MOBILE, {});
    const known = await build({
      existing: { id: 'patient-1', status: 'active' },
    }).service.requestOtp(MOBILE, {});
    expect(unknown).toEqual(known);
  });

  it('will not send a code to a suspended account', async () => {
    const { service, otpRequest } = build({ existing: { id: 'patient-1', status: 'suspended' } });
    await expect(service.requestOtp(MOBILE, {})).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
    expect(otpRequest).not.toHaveBeenCalled();
  });

  it('checks the platform limit before asking the provider for anything', async () => {
    const { service, otpRequest } = build({ limitReached: true });
    await expect(service.requestOtp(MOBILE, {})).rejects.toThrow();
    expect(otpRequest).not.toHaveBeenCalled();
  });

  it('creates the account on the first correct code', async () => {
    const { service, upsert } = build({ existing: null });
    const result = await service.verifyOtp(
      { mobileNumber: MOBILE, challengeId: 'challenge-1', code: '000000', deviceId: 'device-9' },
      {},
    );

    expect(result.isNewAccount).toBe(true);
    expect(result.accessToken).toBeTypeOf('string');
    const [args] = upsert.mock.calls[0];
    expect(args.where).toEqual({ mobileNumber: MOBILE });
    expect(args.create).toMatchObject({ mobileNumber: MOBILE, deviceId: 'device-9' });
  });

  it('signs an existing number in without claiming it is new', async () => {
    const { service } = build({ existing: { id: 'patient-1' } });
    const result = await service.verifyOtp(
      { mobileNumber: MOBILE, challengeId: 'challenge-1', code: '000000' },
      {},
    );
    expect(result.isNewAccount).toBe(false);
  });

  it('replaces the push token on every sign-in (FR-1.8)', async () => {
    const { service, upsert } = build({ existing: { id: 'patient-1' } });
    await service.verifyOtp(
      { mobileNumber: MOBILE, challengeId: 'challenge-1', code: '000000', pushToken: 'fcm-new' },
      {},
    );
    expect(upsert.mock.calls[0][0].update).toMatchObject({ pushToken: 'fcm-new' });
  });

  it('writes no account and issues no token for a wrong code', async () => {
    const { service, upsert, record } = build({ otpValid: false });
    await expect(
      service.verifyOtp({ mobileNumber: MOBILE, challengeId: 'challenge-1', code: '999999' }, {}),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });

    expect(upsert).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      'patient_otp_verify',
      MOBILE,
      expect.objectContaining({ succeeded: false }),
      {},
    );
  });
});

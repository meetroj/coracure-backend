import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AdminAuthService } from './admin-auth.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OtpProvider } from './otp/otp.provider';
import { hashPassword } from './password';
import { TokensService } from './tokens.service';

const SECRET = 'x'.repeat(32);
const PASSWORD = 'correct horse battery';
let PASSWORD_HASH: string;

function build(admin: Record<string, unknown> | null, otpValid = true) {
  const findUnique = vi.fn().mockResolvedValue(admin);
  const prisma = { admin: { findUnique, create: vi.fn() } } as unknown as PrismaService;
  const record = vi.fn().mockResolvedValue(undefined);
  const rateLimit = {
    assertWithinLimit: vi.fn().mockResolvedValue(undefined),
    record,
  } as unknown as LoginRateLimitService;
  const otpRequest = vi
    .fn<OtpProvider['request']>()
    .mockResolvedValue({ challengeId: 'challenge-1' });
  const otpVerify = vi.fn<OtpProvider['verify']>().mockResolvedValue(otpValid);
  const otp: OtpProvider = { request: otpRequest, verify: otpVerify };
  const tokens = new TokensService(new JwtService({ secret: SECRET }));
  return {
    service: new AdminAuthService(prisma, tokens, rateLimit, otp),
    tokens,
    otpRequest,
    record,
    findUnique,
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'admin-1',
  status: 'active',
  tokenVersion: 0,
  passwordHash: PASSWORD_HASH,
  is2faEnabled: false,
  permissionLevel: 'super_admin',
  ...over,
});

describe('AdminAuthService', () => {
  beforeEach(async () => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: SECRET,
    });
    PASSWORD_HASH ??= await hashPassword(PASSWORD);
  });

  it('issues tokens for a correct password when two-factor is off', async () => {
    const { service, tokens } = build(row());
    const result = await service.signIn({ email: 'Admin@Coracure.in', password: PASSWORD }, {});

    expect(result.status).toBe('complete');
    const claims = await tokens.verifyAccess((result as { accessToken: string }).accessToken);
    expect(claims).toMatchObject({ sub: 'admin-1', typ: 'admin', lvl: 'super_admin' });
  });

  it('trims and lower-cases the address before looking it up', async () => {
    const { service, findUnique, record } = build(row());
    await service.signIn({ email: '  Admin@Coracure.IN ', password: PASSWORD }, {});

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'admin@coracure.in' } }),
    );
    // The limit counts the same normalised address, so varying the casing
    // cannot be used to get a fresh allowance.
    expect(record).toHaveBeenCalledWith('admin_login', 'admin@coracure.in', expect.anything(), {});
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    await expect(
      build(row()).service.signIn({ email: 'a@b.in', password: 'nope' }, {}),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });

    await expect(
      build(null).service.signIn({ email: 'a@b.in', password: PASSWORD }, {}),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
  });

  it('records the failure against the address, which is what the limit counts', async () => {
    const { service, record } = build(null);
    await expect(service.signIn({ email: 'a@b.in', password: PASSWORD }, {})).rejects.toThrow();
    expect(record).toHaveBeenCalledWith(
      'admin_login',
      'a@b.in',
      expect.objectContaining({ succeeded: false, reason: 'invalid_credentials' }),
      {},
    );
  });

  it('refuses a suspended admin even with the right password', async () => {
    const { service } = build(row({ status: 'suspended' }));
    await expect(service.signIn({ email: 'a@b.in', password: PASSWORD }, {})).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_ACTIVE' },
    });
  });

  it('stops at a challenge when two-factor is on, issuing no access token', async () => {
    const { service, tokens, otpRequest } = build(row({ is2faEnabled: true }));
    const result = await service.signIn({ email: 'a@b.in', password: PASSWORD }, {});

    expect(result.status).toBe('two_factor_required');
    expect(result).not.toHaveProperty('accessToken');
    expect(otpRequest).toHaveBeenCalledWith('a@b.in', 'admin_2fa');

    const mfaToken = (result as { mfaToken: string }).mfaToken;
    await expect(tokens.verifyAccess(mfaToken)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('completes the sign-in when the second factor is correct', async () => {
    const { service, tokens } = build(row({ is2faEnabled: true }));
    const started = await service.signIn({ email: 'a@b.in', password: PASSWORD }, {});
    const pair = await service.completeTwoFactor(
      { mfaToken: (started as { mfaToken: string }).mfaToken, code: '000000' },
      {},
    );
    expect(await tokens.verifyAccess(pair.accessToken)).toMatchObject({ sub: 'admin-1' });
  });

  it('refuses a wrong second factor', async () => {
    const { service } = build(row({ is2faEnabled: true }), false);
    const started = await service.signIn({ email: 'a@b.in', password: PASSWORD }, {});
    await expect(
      service.completeTwoFactor(
        { mfaToken: (started as { mfaToken: string }).mfaToken, code: '999999' },
        {},
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
  });

  it('refuses the second factor if the account was signed out between the two legs', async () => {
    const { service } = build(row({ is2faEnabled: true, tokenVersion: 0 }));
    const started = await service.signIn({ email: 'a@b.in', password: PASSWORD }, {});

    // Same service, but the row has moved on since the password was accepted.
    const moved = build(row({ is2faEnabled: true, tokenVersion: 1 }));
    await expect(
      moved.service.completeTwoFactor(
        { mfaToken: (started as { mfaToken: string }).mfaToken, code: '000000' },
        {},
      ),
    ).rejects.toMatchObject({ response: { code: 'TOKEN_INVALID' } });
  });
});

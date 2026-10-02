import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetEnvironment, validateEnvironment } from '../config/env.validation';
import { TokensService } from './tokens.service';

const SECRET = 'x'.repeat(32);

function service() {
  return new TokensService(new JwtService({ secret: SECRET }));
}

const PATIENT = { id: 'patient-1', type: 'patient' as const, tokenVersion: 3 };

describe('TokensService', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: SECRET,
    });
  });

  it('carries the revocation version on both tokens', async () => {
    const pair = await service().issue(PATIENT);

    expect(await service().verifyAccess(pair.accessToken)).toMatchObject({
      sub: 'patient-1',
      typ: 'patient',
      ver: 3,
      kind: 'access',
    });
    expect(await service().verifyRefresh(pair.refreshToken)).toMatchObject({ ver: 3, kind: 'refresh' });
  });

  it('refuses a refresh token presented as an access token', async () => {
    const pair = await service().issue(PATIENT);
    await expect(service().verifyAccess(pair.refreshToken)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('refuses an access token presented as a refresh token', async () => {
    const pair = await service().issue(PATIENT);
    await expect(service().verifyRefresh(pair.accessToken)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('refuses a token signed with another secret', async () => {
    const foreign = new TokensService(new JwtService({ secret: 'y'.repeat(32) }));
    const pair = await foreign.issue(PATIENT);
    await expect(service().verifyAccess(pair.accessToken)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('puts the permission level on an admin token and nothing else', async () => {
    const admin = await service().issue({
      id: 'admin-1',
      type: 'admin',
      tokenVersion: 0,
      level: 'super_admin',
    });
    expect(await service().verifyAccess(admin.accessToken)).toMatchObject({ lvl: 'super_admin' });

    const patient = await service().issue(PATIENT);
    expect(await service().verifyAccess(patient.accessToken)).not.toHaveProperty('lvl');
  });

  it('reports the access lifetime in seconds so a client can schedule its refresh', async () => {
    expect((await service().issue(PATIENT)).expiresIn).toBe(15 * 60);
  });

  it('round-trips the two-factor challenge, and it is not an access token', async () => {
    const mfa = await service().issueMfaChallenge(
      { id: 'admin-1', type: 'admin', tokenVersion: 1 },
      'challenge-9',
    );

    expect(await service().verifyMfaChallenge(mfa)).toMatchObject({
      sub: 'admin-1',
      ver: 1,
      challengeId: 'challenge-9',
    });
    await expect(service().verifyAccess(mfa)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });
});

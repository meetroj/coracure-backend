import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { LoginRateLimitService, RATE_LIMIT_DEFAULTS } from './login-rate-limit.service';

type CountArgs = { action: string; entityType: string; entityId?: string; ipAddress?: string; since: Date };

function serviceWith(attempts: number, configured?: unknown) {
  const countSince = vi.fn<(args: CountArgs) => Promise<number>>().mockResolvedValue(attempts);
  const record = vi.fn<(entry: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
  const audit = { countSince, record } as unknown as AuditService;
  const config = {
    get: vi.fn().mockResolvedValue(configured),
  } as unknown as AppConfigService;
  return { service: new LoginRateLimitService(audit, config), countSince, record };
}

describe('LoginRateLimitService', () => {
  it('counts from the audit log, not from a counter column', async () => {
    const { service, countSince } = serviceWith(0);
    await service.assertWithinLimit('patient_otp_request', '+919876543210');

    expect(countSince).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'login',
        entityType: 'patient_otp_request',
        entityId: '+919876543210',
      }),
    );
  });

  it('allows the attempt that reaches the limit but not the one after', async () => {
    const limit = RATE_LIMIT_DEFAULTS.patient_otp_request.limit;

    const { service: under } = serviceWith(limit - 1);
    await expect(under.assertWithinLimit('patient_otp_request', '+91987')).resolves.toBeUndefined();

    const { service: at } = serviceWith(limit);
    await expect(at.assertWithinLimit('patient_otp_request', '+91987')).rejects.toMatchObject({
      response: { code: 'TOO_MANY_ATTEMPTS' },
    });
  });

  it('uses the window an admin configured over the shipped default', async () => {
    const { service, countSince } = serviceWith(2, {
      ...RATE_LIMIT_DEFAULTS,
      patient_otp_request: { limit: 2, windowMinutes: 60 },
    });

    await expect(service.assertWithinLimit('patient_otp_request', '+91987')).rejects.toMatchObject({
      response: { code: 'TOO_MANY_ATTEMPTS' },
    });
    const { since } = countSince.mock.calls[0][0];
    expect(Date.now() - since.getTime()).toBeGreaterThan(59 * 60_000);
  });

  it('limits each identifier separately, so one number cannot lock out another', async () => {
    const { service, countSince } = serviceWith(0);
    await service.assertWithinLimit('patient_otp_verify', '+911111111111');
    await service.assertWithinLimit('patient_otp_verify', '+922222222222');

    expect(countSince.mock.calls.map(([args]) => args.entityId)).toEqual([
      '+911111111111',
      '+922222222222',
    ]);
  });

  it('records a failed attempt with its reason, ip and user agent', async () => {
    const { service, record } = serviceWith(0);
    await service.record(
      'admin_login',
      'admin@coracure.in',
      { succeeded: false, reason: 'invalid_credentials' },
      { ipAddress: '203.0.113.7', userAgent: 'Chrome' },
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        action: 'login',
        entityType: 'admin_login',
        entityId: 'admin@coracure.in',
        ipAddress: '203.0.113.7',
        metadata: { succeeded: false, reason: 'invalid_credentials', userAgent: 'Chrome' },
      }),
    );
  });

  describe('per client address (doctor sign-up is open)', () => {
    it('counts the OTP requests from one address, whatever numbers they were for', async () => {
      const { service, countSince } = serviceWith(0);
      await service.assertIpWithinLimit('203.0.113.9');

      const args = countSince.mock.calls[0][0];
      expect(args).toMatchObject({ action: 'login', entityType: 'doctor_otp_request', ipAddress: '203.0.113.9' });
      expect(args).not.toHaveProperty('entityId');
    });

    it('allows the request that reaches the limit but not the one after', async () => {
      const limit = RATE_LIMIT_DEFAULTS.doctor_otp_request_per_ip.limit;
      await expect(serviceWith(limit - 1).service.assertIpWithinLimit('203.0.113.9')).resolves.toBeUndefined();
      await expect(serviceWith(limit).service.assertIpWithinLimit('203.0.113.9')).rejects.toMatchObject({
        status: 429,
        response: { code: 'TOO_MANY_ATTEMPTS' },
      });
    });

    it('cannot count what it cannot see: no address means no per-address limit', async () => {
      const { service, countSince } = serviceWith(999);
      await expect(service.assertIpWithinLimit(null)).resolves.toBeUndefined();
      expect(countSince).not.toHaveBeenCalled();
    });

    it('uses the limit an admin configured over the shipped default', async () => {
      const { service } = serviceWith(3, { doctor_otp_request_per_ip: { limit: 3, windowMinutes: 10 } });
      await expect(service.assertIpWithinLimit('203.0.113.9')).rejects.toMatchObject({ status: 429 });
    });
  });
});

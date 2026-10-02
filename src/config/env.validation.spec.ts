import { beforeEach, describe, expect, it } from 'vitest';

import { env, resetEnvironment, validateEnvironment } from './env.validation';

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

/** Everything production demands, so a case can break exactly one of them. */
const PRODUCTION = {
  NODE_ENV: 'production',
  OTP_PROVIDER: 'slide',
  SLIDE_API_KEY: 'k',
  SLIDE_WIDGET_ID: 'w',
  STORAGE_PROVIDER: 's3',
  AWS_S3_BUCKET: 'coracure-documents',
  PUSH_PROVIDER: 'fcm',
  FCM_PATIENT_CREDENTIALS: '{}',
  FCM_DOCTOR_CREDENTIALS: '{}',
  PAYMENT_GATEWAY: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_live_x',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
  LIVEKIT_URL: 'wss://livekit.coracure.example',
  LIVEKIT_API_KEY: 'APIproduction',
  LIVEKIT_API_SECRET: 'a-real-secret',
};

describe('validateEnvironment', () => {
  beforeEach(() => resetEnvironment());

  it('applies defaults and coerces types', () => {
    const result = validateEnvironment({ ...VALID, PORT: '4000' });
    expect(result.PORT).toBe(4000);
    expect(result.NODE_ENV).toBe('development');
    expect(result.TRUST_PROXY).toBe(false);
  });

  it('keeps variables it does not own, for later modules', () => {
    const result = validateEnvironment({ ...VALID, RAZORPAY_KEY_ID: 'rzp_test' });
    expect(result.RAZORPAY_KEY_ID).toBe('rzp_test');
  });

  it.each([
    ['a missing database url', { DATABASE_URL: undefined }],
    ['a database url that is not postgres', { DATABASE_URL: 'mysql://localhost/db' }],
    ['a jwt secret that is too short', { JWT_ACCESS_SECRET: 'short' }],
    ['a port outside the valid range', { PORT: '70000' }],
    ['an unknown log level', { LOG_LEVEL: 'chatty' }],
    // M-02: the stub OTP provider accepts one fixed code, so it must never
    // reach production, and `slide` is useless without its key.
    ['the otp stub in production', { NODE_ENV: 'production', OTP_PROVIDER: 'stub' }],
    ['slide selected but no api key', { OTP_PROVIDER: 'slide' }],
    // M-07: a typo here would silently shift every provider's diary.
    ['a time zone ICU does not know', { PLATFORM_TIMEZONE: 'Mars/Olympus' }],
    // M-08: the log push provider delivers nothing, so production must not run
    // on it - a platform that silently stops notifying anybody looks healthy.
    ['the log push provider in production', { NODE_ENV: 'production', PUSH_PROVIDER: 'log' }],
    ['fcm selected but no patient credentials', { PUSH_PROVIDER: 'fcm' }],
    // M-12: the stub settles nothing, and without a webhook secret any caller
    // could mark a consultation paid.
    ['the payment stub in production', { NODE_ENV: 'production', PAYMENT_GATEWAY: 'stub' }],
    ['razorpay selected but no keys', { PAYMENT_GATEWAY: 'razorpay' }],
    [
      'razorpay selected but no webhook secret',
      { PAYMENT_GATEWAY: 'razorpay', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' },
    ],
    [
      'fcm selected with only the patient app configured',
      { PUSH_PROVIDER: 'fcm', FCM_PATIENT_CREDENTIALS: '{}' },
    ],
    // M-14: a key signs nothing without its secret, and a secret verifies
    // nothing without its key, so half a pair is always a misconfiguration.
    ['a livekit key with no secret', { LIVEKIT_API_KEY: 'devkey' }],
    ['a livekit secret with no key', { LIVEKIT_API_SECRET: 'shhh' }],
    // Without these, production has a video product that cannot start a call.
    [
      'no livekit credentials in production',
      { ...PRODUCTION, LIVEKIT_API_SECRET: undefined, LIVEKIT_API_KEY: undefined },
    ],
    // A ws:// endpoint carries the join token - a bearer credential for a
    // clinical call - in clear text.
    [
      'an insecure livekit url in production',
      { ...PRODUCTION, LIVEKIT_URL: 'ws://livekit.example' },
    ],
    // LiveKit_strategy 31: the committed development pair is public, and a
    // public key is not a key.
    [
      'the committed development livekit key in production',
      { ...PRODUCTION, LIVEKIT_API_KEY: 'devkey' },
    ],
  ])('refuses to boot with %s', (_case, override) => {
    expect(() => validateEnvironment({ ...VALID, ...override })).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('reports every problem at once', () => {
    try {
      validateEnvironment({ JWT_ACCESS_SECRET: 'short' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).toContain('JWT_ACCESS_SECRET');
    }
  });

  it('defaults the diary time zone and the push provider', () => {
    // Both have to work with nothing set: M-07 needs a zone before anyone
    // configures one, and M-08 has to run before any FCM key exists.
    const result = validateEnvironment({ ...VALID });
    expect(result.PLATFORM_TIMEZONE).toBe('Asia/Kolkata');
    expect(result.PUSH_PROVIDER).toBe('log');
  });

  it('accepts a production environment once every stub is replaced', () => {
    expect(() => validateEnvironment({ ...VALID, ...PRODUCTION })).not.toThrow();
  });

  it('caches the parsed environment for typed access', () => {
    validateEnvironment({ ...VALID, API_PREFIX: 'api' });
    expect(env().API_PREFIX).toBe('api');
  });
});

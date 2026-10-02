import { ArgumentsHost, BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppException, ErrorResponse, PlatformError } from './errors';
import { HttpExceptionFilter } from './http-exception.filter';
import { resetEnvironment, validateEnvironment } from '../config/env.validation';

const ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/coracure',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

function capture(exception: unknown): { status: number; body: ErrorResponse } {
  const sent = { status: 0, body: {} as ErrorResponse };
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: ErrorResponse) {
      sent.body = body;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', url: '/api/v1/thing' }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return sent;
}

describe('HttpExceptionFilter', () => {
  beforeEach(() => {
    resetEnvironment();
    validateEnvironment(ENV);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('returns the declared code and status of an AppException', () => {
    const { status, body } = capture(
      new AppException('SLOT_TAKEN', 'That slot has just been booked', 409, { slot: '10:00' }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'SLOT_TAKEN',
      message: 'That slot has just been booked',
      details: { slot: '10:00' },
      path: '/api/v1/thing',
      requestId: 'req-1',
    });
  });

  it('derives a code from a plain Nest exception', () => {
    const { status, body } = capture(new ForbiddenException());
    expect(status).toBe(403);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('collects field errors from the validation pipe into details', () => {
    const { body } = capture(new BadRequestException(['mobileNumber must be a valid number']));
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toBe('Request validation failed');
    expect(body.details).toEqual(['mobileNumber must be a valid number']);
  });

  it('maps a unique-constraint failure to a conflict', () => {
    const prismaError = Object.assign(new Error('Unique constraint failed'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
    });
    const { status, body } = capture(prismaError);
    expect(status).toBe(409);
    expect(body.code).toBe(PlatformError.CONFLICT);
  });

  it('never leaks internals in production', () => {
    resetEnvironment();
    // A production environment must also satisfy the checks later modules add:
    // the OTP stub accepts a fixed code (M-02), the storage stub keeps nothing
    // (M-05), the log push provider delivers nothing (M-08) and LiveKit without
    // its credentials cannot start a call (M-14), so `env.validation` refuses to
    // boot production with any of them.
    validateEnvironment({
      ...ENV,
      NODE_ENV: 'production',
      OTP_PROVIDER: 'slide',
      SLIDE_API_KEY: 'slide-key',
      SLIDE_WIDGET_ID: 'slide-widget',
      STORAGE_PROVIDER: 's3',
      AWS_S3_BUCKET: 'coracure-documents',
      PUSH_PROVIDER: 'fcm',
      FCM_PATIENT_CREDENTIALS: '{"project_id":"p","client_email":"e","private_key":"k"}',
      FCM_DOCTOR_CREDENTIALS: '{"project_id":"d","client_email":"e","private_key":"k"}',
      PAYMENT_GATEWAY: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_live_x',
      RAZORPAY_KEY_SECRET: 'secret',
      LIVEKIT_URL: 'wss://livekit.coracure.example',
      LIVEKIT_API_KEY: 'APIproduction',
      LIVEKIT_API_SECRET: 'livekit-secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
    });
    const { status, body } = capture(new Error('connection string postgres://secret@host'));
    expect(status).toBe(500);
    expect(body.code).toBe(PlatformError.INTERNAL_ERROR);
    expect(body.message).toBe('Internal server error');
  });
});

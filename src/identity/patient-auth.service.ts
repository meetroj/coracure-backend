import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { AccountsService, assertSignInAllowed } from './accounts.service';
import { IdentityError } from './identity.errors';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OTP_PROVIDER, OtpProvider } from './otp/otp.provider';
import { TokenPair, TokensService } from './tokens.service';

/** Where the attempt came from, for the audit trail FR-1.8 asks for. */
export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Patient sign-up and sign-in, which are the same flow (FR-1.1): there is no
 * password and no separate registration. A first correct OTP creates the row;
 * every later one signs the same row in.
 */
@Injectable()
export class PatientAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
    private readonly rateLimit: LoginRateLimitService,
    private readonly audit: AuditService,
    @Inject(OTP_PROVIDER) private readonly otp: OtpProvider,
  ) {}

  /**
   * Asks Slide to send a code. Deliberately says nothing about whether the
   * number is already registered - that would make this endpoint an oracle for
   * who holds an account on the platform.
   */
  async requestOtp(mobileNumber: string, context: RequestContext): Promise<{ challengeId: string }> {
    await this.rateLimit.assertWithinLimit('patient_otp_request', mobileNumber);

    // A suspended account must not be able to have codes sent to it.
    const existing = await this.prisma.patient.findUnique({
      where: { mobileNumber },
      select: { id: true, status: true },
    });
    if (existing) assertSignInAllowed(existing.status);

    const challenge = await this.otp.request(mobileNumber, 'patient_signin');
    await this.rateLimit.record(
      'patient_otp_request',
      mobileNumber,
      { succeeded: true, accountId: existing?.id ?? null },
      context,
    );
    return { challengeId: challenge.challengeId };
  }

  /**
   * Verifies the code and hands back tokens, creating the account on first use.
   * The row existing IS the proof the number was verified, which is why
   * `patients` carries no `mobile_verified_at`.
   */
  async verifyOtp(
    input: { mobileNumber: string; challengeId: string; code: string; pushToken?: string; deviceId?: string },
    context: RequestContext,
  ): Promise<TokenPair & { isNewAccount: boolean }> {
    await this.rateLimit.assertWithinLimit('patient_otp_verify', input.mobileNumber);

    const verified = await this.otp.verify(input.challengeId, input.code);
    if (!verified) {
      await this.rateLimit.record(
        'patient_otp_verify',
        input.mobileNumber,
        { succeeded: false, reason: 'invalid_code' },
        context,
      );
      throw new AppException(
        IdentityError.INVALID_CREDENTIALS,
        'That code is not correct or has expired.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const before = await this.prisma.patient.findUnique({
      where: { mobileNumber: input.mobileNumber },
      select: { id: true },
    });
    if (!before) {
      await this.audit.record({
        actorType: 'system',
        action: 'create',
        entityType: 'patient',
        entityId: input.mobileNumber,
        metadata: { via: 'otp_signup' },
        ipAddress: context.ipAddress,
      });
    }

    // Upsert, not create-then-sign-in: two verifications racing on a new number
    // must not fail one of them on the unique index.
    const patient = await this.prisma.patient.upsert({
      where: { mobileNumber: input.mobileNumber },
      create: {
        mobileNumber: input.mobileNumber,
        pushToken: input.pushToken ?? null,
        deviceId: input.deviceId ?? null,
      },
      update: {
        ...(input.pushToken ? { pushToken: input.pushToken } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      },
      select: { id: true, status: true, tokenVersion: true },
    });
    assertSignInAllowed(patient.status);

    await this.rateLimit.record(
      'patient_otp_verify',
      input.mobileNumber,
      { succeeded: true, accountId: patient.id },
      context,
    );

    const pair = await this.tokens.issue(AccountsService.subject('patient', patient));
    return { ...pair, isNewAccount: !before };
  }
}

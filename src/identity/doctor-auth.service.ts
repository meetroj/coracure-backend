import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DoctorVerificationStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { AccountsService, assertDoctorSignInAllowed } from './accounts.service';
import { IdentityError } from './identity.errors';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OTP_PROVIDER, OtpProvider } from './otp/otp.provider';
import { RequestContext } from './patient-auth.service';
import { TokenPair, TokensService } from './tokens.service';

/**
 * A doctor signs in by mobile number and OTP, exactly like a patient - and,
 * exactly like a patient, signs UP the same way: the first verified code for a
 * new number creates the account, in `pending` with no name. What follows is
 * onboarding and KYC, and an admin approves or rejects it (M-05). Nothing about
 * being a doctor is granted by having a row: every consulting route still
 * checks `verified` on the row itself.
 *
 * Because sign-up is open, `requestOtp` can no longer refuse a stranger, and every
 * code it sends is an SMS the client pays for. Two limits stand in for the old
 * refusal: FR-1.9's per-number limit, and a per-address one that stops a single
 * client asking for codes to many different numbers.
 */
@Injectable()
export class DoctorAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
    private readonly rateLimit: LoginRateLimitService,
    private readonly audit: AuditService,
    @Inject(OTP_PROVIDER) private readonly otp: OtpProvider,
  ) {}

  /** Sends a code to any number. A new number is how a doctor starts signing up. */
  async requestOtp(mobileNumber: string, context: RequestContext): Promise<{ challengeId: string }> {
    await this.rateLimit.assertWithinLimit('doctor_otp_request', mobileNumber);
    await this.rateLimit.assertIpWithinLimit(context.ipAddress);

    const doctor = await this.prisma.doctor.findUnique({
      where: { mobileNumber },
      select: { id: true, verificationStatus: true },
    });
    if (doctor) assertDoctorSignInAllowed(doctor.verificationStatus);

    const challenge = await this.otp.request(mobileNumber, 'doctor_signin');
    await this.rateLimit.record(
      'doctor_otp_request',
      mobileNumber,
      { succeeded: true, accountId: doctor?.id },
      context,
    );
    return { challengeId: challenge.challengeId };
  }

  /**
   * Verifies the code and hands back tokens, creating the account on the first
   * success for a number.
   *
   * The code is checked BEFORE any row exists, so a wrong code can never leave
   * an account behind. The row is written with an upsert: two verifications
   * racing on a new number must not fail one of them on the unique index. It
   * is created with `mobile_verified_at` already set - this very call is the
   * proof that somebody holds the number.
   */
  async verifyOtp(
    input: {
      mobileNumber: string;
      challengeId: string;
      code: string;
      pushToken?: string;
      deviceId?: string;
    },
    context: RequestContext,
  ): Promise<TokenPair & { verificationStatus: DoctorVerificationStatus; isNewAccount: boolean }> {
    await this.rateLimit.assertWithinLimit('doctor_otp_verify', input.mobileNumber);

    const before = await this.prisma.doctor.findUnique({
      where: { mobileNumber: input.mobileNumber },
      select: { id: true, verificationStatus: true, mobileVerifiedAt: true },
    });
    if (before) assertDoctorSignInAllowed(before.verificationStatus);

    const verified = await this.otp.verify(input.challengeId, input.code);
    if (!verified) {
      await this.rateLimit.record(
        'doctor_otp_verify',
        input.mobileNumber,
        { succeeded: false, reason: 'invalid_code', accountId: before?.id },
        context,
      );
      throw invalidCode();
    }

    if (!before) {
      await this.audit.record({
        actorType: 'system',
        action: 'create',
        entityType: 'doctor',
        entityId: input.mobileNumber,
        metadata: { via: 'otp_signup' },
        ipAddress: context.ipAddress,
      });
    }

    const doctor = await this.prisma.doctor.upsert({
      where: { mobileNumber: input.mobileNumber },
      create: {
        mobileNumber: input.mobileNumber,
        // NOT NULL with no default. Blank, so onboarding does not pre-fill a
        // name nobody typed; it is required there.
        fullName: '',
        mobileVerifiedAt: new Date(),
        pushToken: input.pushToken ?? null,
        deviceId: input.deviceId ?? null,
      },
      update: {
        ...(before?.mobileVerifiedAt ? {} : { mobileVerifiedAt: new Date() }),
        ...(input.pushToken ? { pushToken: input.pushToken } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      },
      select: { id: true, verificationStatus: true, tokenVersion: true },
    });
    assertDoctorSignInAllowed(doctor.verificationStatus);

    await this.rateLimit.record(
      'doctor_otp_verify',
      input.mobileNumber,
      { succeeded: true, accountId: doctor.id },
      context,
    );

    const pair = await this.tokens.issue(AccountsService.subject('doctor', doctor));
    // The app routes on this: a new or unverified doctor lands on onboarding or
    // the status screen, not the dashboard.
    return { ...pair, verificationStatus: doctor.verificationStatus, isNewAccount: !before };
  }
}

function invalidCode(): AppException {
  return new AppException(
    IdentityError.INVALID_CREDENTIALS,
    'That code is not correct or has expired.',
    HttpStatus.UNAUTHORIZED,
  );
}

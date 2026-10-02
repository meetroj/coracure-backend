import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { AccountsService, assertSignInAllowed } from './accounts.service';
import { IdentityError } from './identity.errors';
import { LoginRateLimitService } from './login-rate-limit.service';
import { OTP_PROVIDER, OtpProvider } from './otp/otp.provider';
import { RequestContext } from './patient-auth.service';
import { hashPassword, verifyPassword } from './password';
import { TokenPair, TokensService } from './tokens.service';

/** Either the sign-in finished, or it is waiting on a two-factor code. */
export type AdminSignIn =
  | ({ status: 'complete' } & TokenPair)
  | { status: 'two_factor_required'; mfaToken: string };

/**
 * Admin sign-in: email and password, then an optional Slide OTP when the
 * account has `is_2fa_enabled` (FR-1.4). Admins are never self-registered -
 * `create` is called by another admin.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly rateLimit: LoginRateLimitService,
    @Inject(OTP_PROVIDER) private readonly otp: OtpProvider,
  ) {}

  async signIn(
    input: { email: string; password: string },
    context: RequestContext,
  ): Promise<AdminSignIn> {
    const email = input.email.trim().toLowerCase();
    await this.rateLimit.assertWithinLimit('admin_login', email);

    const admin = await this.prisma.admin.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        tokenVersion: true,
        passwordHash: true,
        is2faEnabled: true,
        permissionLevel: true,
      },
    });

    // Verify against a decoy hash when the account is unknown, so the response
    // time does not reveal which addresses exist.
    const correct = await verifyPassword(admin?.passwordHash ?? DECOY_HASH, input.password);
    if (!admin || !correct) {
      await this.rateLimit.record(
        'admin_login',
        email,
        { succeeded: false, accountId: admin?.id ?? null, reason: 'invalid_credentials' },
        context,
      );
      throw new AppException(
        IdentityError.INVALID_CREDENTIALS,
        'That email address or password is not correct.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    assertSignInAllowed(admin.status);

    if (admin.is2faEnabled) {
      // Not yet a sign-in, so nothing is recorded as one until the code lands.
      const challenge = await this.otp.request(email, 'admin_2fa');
      const mfaToken = await this.tokens.issueMfaChallenge(
        AccountsService.subject('admin', admin),
        challenge.challengeId,
      );
      return { status: 'two_factor_required', mfaToken };
    }

    await this.rateLimit.record('admin_login', email, { succeeded: true, accountId: admin.id }, context);
    return { status: 'complete', ...(await this.tokens.issue(AccountsService.subject('admin', admin))) };
  }

  /** Second leg of a two-factor sign-in. The mfa token says which account; the code proves it. */
  async completeTwoFactor(
    input: { mfaToken: string; code: string },
    context: RequestContext,
  ): Promise<TokenPair> {
    const claims = await this.tokens.verifyMfaChallenge(input.mfaToken);
    await this.rateLimit.assertWithinLimit('admin_login', claims.sub);

    const verified = await this.otp.verify(claims.challengeId, input.code);
    if (!verified) {
      await this.rateLimit.record(
        'admin_login',
        claims.sub,
        { succeeded: false, accountId: claims.sub, reason: 'invalid_2fa_code' },
        context,
      );
      throw new AppException(
        IdentityError.INVALID_CREDENTIALS,
        'That code is not correct or has expired.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const admin = await this.prisma.admin.findUnique({
      where: { id: claims.sub },
      select: { id: true, status: true, tokenVersion: true, permissionLevel: true },
    });
    // The password leg happened minutes ago; the account may have been
    // suspended or signed out everywhere since.
    if (!admin || admin.tokenVersion !== claims.ver) {
      throw new AppException(
        IdentityError.TOKEN_INVALID,
        'Your sign-in attempt has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    assertSignInAllowed(admin.status);

    await this.rateLimit.record('admin_login', claims.sub, { succeeded: true, accountId: admin.id }, context);
    return this.tokens.issue(AccountsService.subject('admin', admin));
  }

  /**
   * Creates another admin. There is no self sign-up path, and who created the
   * account is the `audit_log` row the caller writes - which is why `admins`
   * has no `created_by`.
   */
  async create(input: {
    email: string;
    password: string;
    fullName: string;
    permissionLevel: string;
    is2faEnabled?: boolean;
  }): Promise<{ id: string }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.admin.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new AppException(
        'CONFLICT',
        'An admin with that email address already exists.',
        HttpStatus.CONFLICT,
      );
    }
    const created = await this.prisma.admin.create({
      data: {
        email,
        passwordHash: await hashPassword(input.password),
        fullName: input.fullName,
        permissionLevel: input.permissionLevel as never,
        is2faEnabled: input.is2faEnabled ?? false,
      },
      select: { id: true },
    });
    return created;
  }
}

/**
 * A real argon2id hash of a value nobody knows. Verifying against it costs the
 * same as verifying a real one, which is what keeps sign-in timing flat for
 * unknown addresses.
 */
const DECOY_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$kdZSZfYz6fzmjfyQkRIXyw$zjdeHixaoKBF4+KwZ9KK5KpTJ1MEoXoXWAski8ZdBo8';

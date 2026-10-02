import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AppConfigService } from '../app-config/app-config.service';
import { env } from '../config/env.validation';
import { AccountsService } from './accounts.service';
import { AdminAuthService } from './admin-auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { DoctorAuthService } from './doctor-auth.service';
import {
  LoginRateLimitService,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_KEY,
  RATE_LIMIT_SCHEMA,
} from './login-rate-limit.service';
import { OTP_PROVIDER } from './otp/otp.provider';
import { SlideOtpProvider } from './otp/slide.provider';
import { StubOtpProvider } from './otp/stub.provider';
import { PatientAuthService } from './patient-auth.service';
import { TokensService } from './tokens.service';

/**
 * M-02 Identity and Access. Owns `patients` and `admins`. It authenticates
 * doctors too, but the `doctors` row belongs to M-05, which holds the
 * registration and verification state this module's doctor branch reads.
 *
 * Global, because every later module resolves an actor through `AuthGuard` and
 * checks ownership against it.
 */
@Global()
@Module({
  imports: [
    // One secret for both tokens. They are told apart by a mandatory audience
    // AND a `kind` claim, both verified, so a refresh token can never be
    // presented as an access token.
    JwtModule.register({ global: false, secret: env().JWT_ACCESS_SECRET }),
  ],
  controllers: [AuthController],
  providers: [
    AccountsService,
    TokensService,
    LoginRateLimitService,
    PatientAuthService,
    DoctorAuthService,
    AdminAuthService,
    {
      provide: OTP_PROVIDER,
      // Slide owns OTP state (SRS 3.3). The stub is refused in production by
      // `env.validation`, so this cannot silently ship accepting a fixed code.
      useClass: env().OTP_PROVIDER === 'slide' ? SlideOtpProvider : StubOtpProvider,
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AccountsService, TokensService],
})
export class IdentityModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** FR-1.9's limits become admin-editable data on first boot, not constants in code. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: RATE_LIMIT_KEY,
        value: RATE_LIMIT_DEFAULTS,
        description:
          'Sign-in attempt ceilings per identifier, counted from audit_log where action = login (FR-1.9).',
        // The SAME schema the rate limiter validates against on read, not a
        // second copy - two shapes for one value is how they drift.
        schema: RATE_LIMIT_SCHEMA,
        // Super admin only: loosening a sign-in ceiling is a security change,
        // and the empty list plus the blanket super-admin rule says exactly that.
        editableBy: [],
      },
    ]);
  }
}

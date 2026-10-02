import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { AccountsService } from './accounts.service';
import { AdminAuthService } from './admin-auth.service';
import { DoctorAuthService } from './doctor-auth.service';
import {
  AdminSignInDto,
  AdminTwoFactorDto,
  CreateAdminDto,
  RefreshDto,
  RequestOtpDto,
  VerifyOtpDto,
} from './dto/auth.dto';
import { IdentityError } from './identity.errors';
import { PatientAuthService, RequestContext } from './patient-auth.service';
import { Public } from './public.decorator';
import { TokensService } from './tokens.service';

/** IP and user agent are audit facts; they are written to the log, never to an account row. */
function contextOf(request: FastifyRequest): RequestContext {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly patients: PatientAuthService,
    private readonly doctors: DoctorAuthService,
    private readonly admins: AdminAuthService,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
  ) {}

  // -- Patient app ----------------------------------------------------------

  @Public()
  @Post('patient/otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a sign-in code to a mobile number',
    description:
      'Sign-up and sign-in are the same call (FR-1.1). The response is identical whether or not the number already has an account, so this cannot be used to discover who is registered.',
  })
  requestPatientOtp(@Body() dto: RequestOtpDto, @Req() request: FastifyRequest) {
    return this.patients.requestOtp(dto.mobileNumber, contextOf(request));
  }

  @Public()
  @Post('patient/otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a code for tokens, creating the account on first use',
    description:
      'A patient row is written only once the code is confirmed, so the row existing IS the proof the number was verified.',
  })
  verifyPatientOtp(@Body() dto: VerifyOtpDto, @Req() request: FastifyRequest) {
    return this.patients.verifyOtp(dto, contextOf(request));
  }

  // -- Doctor app -----------------------------------------------------------

  @Public()
  @Post('doctor/otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a sign-in code to a doctor',
    description:
      'FR-1.2. Sign-in and sign-up are the same call, as for patients: a number nobody has used yet gets a code too, and verifying it creates the account (then onboarding and admin verification, M-05). Limited per number AND per client address, because every code is a paid SMS.',
  })
  requestDoctorOtp(@Body() dto: RequestOtpDto, @Req() request: FastifyRequest) {
    return this.doctors.requestOtp(dto.mobileNumber, contextOf(request));
  }

  @Public()
  @Post('doctor/otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a code for tokens',
    description:
      'The first success for a number creates the doctor (`isNewAccount: true`) with `mobile_verified_at` already set. The response carries `verificationStatus`, which is what the app routes on: a new or unverified doctor lands on onboarding or the status screen, not the dashboard.',
  })
  verifyDoctorOtp(@Body() dto: VerifyOtpDto, @Req() request: FastifyRequest) {
    return this.doctors.verifyOtp(dto, contextOf(request));
  }

  // -- Admin panel ----------------------------------------------------------

  @Public()
  @Post('admin/sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin email and password sign-in',
    description:
      'Returns tokens, or `status: "two_factor_required"` with an `mfaToken` when the account has two-factor enabled.',
  })
  signInAdmin(@Body() dto: AdminSignInDto, @Req() request: FastifyRequest) {
    return this.admins.signIn(dto, contextOf(request));
  }

  @Public()
  @Post('admin/two-factor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Second leg of an admin sign-in that requires two-factor' })
  completeAdminTwoFactor(@Body() dto: AdminTwoFactorDto, @Req() request: FastifyRequest) {
    return this.admins.completeTwoFactor(dto, contextOf(request));
  }

  @Roles('admin')
  @ApiBearerAuth()
  @Post('admin/accounts')
  @ApiOperation({
    summary: 'Create another admin account',
    description:
      'There is no admin self sign-up. Who created the account is this call\'s audit entry, which is why `admins` has no `created_by` column.',
  })
  async createAdmin(@Body() dto: CreateAdminDto, @CurrentActor() actor: AuthenticatedActor) {
    // Creating an account that can create accounts is super_admin only, and
    // `assertPermission` passes super_admin by definition.
    assertPermission(actor);
    const created = await this.admins.create(dto);
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'admin',
      entityId: created.id,
      metadata: { email: dto.email, permissionLevel: dto.permissionLevel },
    });
    return created;
  }

  // -- Every app ------------------------------------------------------------

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Nothing is stored, so this works until the refresh token expires or the account\'s `token_version` moves. A revoked token is refused here as everywhere else.',
  })
  async refresh(@Body() dto: RefreshDto) {
    const claims = await this.tokens.verifyRefresh(dto.refreshToken);
    const actor = await this.accounts.resolve(claims);
    if (!actor) {
      throw new AppException(
        IdentityError.TOKEN_INVALID,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.tokens.issue({
      id: actor.id,
      type: actor.type,
      tokenVersion: claims.ver,
      ...(actor.level ? { level: actor.level } : {}),
    });
  }

  @Roles('patient', 'doctor', 'admin')
  @ApiBearerAuth()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out of EVERY device',
    description:
      'Revocation is one `token_version` increment, so there is no way to end a single device\'s session without ending the rest. Push delivery stops with it (FR-1.8).',
  })
  async signOut(@CurrentActor() actor: AuthenticatedActor, @Req() request: FastifyRequest) {
    await this.accounts.revokeAllTokens(actor);
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'account_revocation',
      entityId: actor.id,
      metadata: { reason: 'sign_out' },
      ipAddress: request.ip,
    });
  }
}

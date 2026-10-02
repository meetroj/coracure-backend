import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DoctorVerificationStatus } from '@prisma/client';
import { FastifyRequest } from 'fastify';

import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { DoctorsError } from './doctors.errors';

export const VERIFIED_DOCTOR_KEY = 'doctors:verified-only';

/**
 * *** THE DOOR TO THE DOCTOR EXPERIENCE ***
 *
 * MODULES M-05 is done when "an unapproved doctor cannot use the doctor
 * experience". A doctor who has not been verified can still sign in - they have
 * to, to upload their credentials and to see what an admin rejected - so the
 * gate cannot be at sign-in. It is here instead: every route that is part of
 * consulting carries this, and M-07 onward put it on theirs.
 *
 * It reads the row rather than the token, so revoking a doctor's approval takes
 * effect on their very next request and never waits for a token to expire.
 */
export const VerifiedDoctorsOnly = () => SetMetadata(VERIFIED_DOCTOR_KEY, true);

@Injectable()
export class VerifiedDoctorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<boolean>(VERIFIED_DOCTOR_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const actor = context.switchToHttp().getRequest<FastifyRequest>().actor;
    // An admin reaching a doctor-experience route is a different question,
    // answered by `@Roles()` on the route itself. This guard only judges doctors.
    if (!actor || actor.type !== 'doctor') return true;

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: actor.id },
      select: { verificationStatus: true },
    });
    if (doctor?.verificationStatus !== DoctorVerificationStatus.verified) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_APPROVED,
        'Your account is still being verified. You can upload your credentials, and an admin will approve them.',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}

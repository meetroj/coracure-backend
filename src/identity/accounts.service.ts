import { HttpStatus, Injectable } from '@nestjs/common';
import { AccountStatus, DoctorVerificationStatus } from '@prisma/client';

import { AdminPermissionLevel, AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { IdentityError } from './identity.errors';
import { TokenSubject } from './tokens.service';

/**
 * The one place that turns an account row into something the rest of the
 * platform can carry, and the one place that revokes it.
 *
 * One branch per account table, because the table an account lives in IS its
 * role. `doctors` is read here but owned by M-05, which holds the registration
 * and verification state the doctor branch checks.
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the account behind a token's claims, or null if it is gone. The
   * `ver` comparison is the revocation check - a token issued before the last
   * `token_version` bump resolves to nothing, whatever its expiry says.
   */
  async resolve(claims: {
    sub: string;
    typ: AuthenticatedActor['type'];
    ver: number;
  }): Promise<AuthenticatedActor | null> {
    if (claims.typ === 'patient') {
      const patient = await this.prisma.patient.findUnique({
        where: { id: claims.sub },
        select: { id: true, status: true, tokenVersion: true },
      });
      if (!patient || patient.tokenVersion !== claims.ver) return null;
      assertSignInAllowed(patient.status);
      return { type: 'patient', id: patient.id };
    }

    if (claims.typ === 'admin') {
      const admin = await this.prisma.admin.findUnique({
        where: { id: claims.sub },
        select: { id: true, status: true, tokenVersion: true, permissionLevel: true },
      });
      if (!admin || admin.tokenVersion !== claims.ver) return null;
      assertSignInAllowed(admin.status);
      return { type: 'admin', id: admin.id, level: admin.permissionLevel };
    }

    const doctor = await this.prisma.doctor.findUnique({
      where: { id: claims.sub },
      select: { id: true, verificationStatus: true, tokenVersion: true },
    });
    if (!doctor || doctor.tokenVersion !== claims.ver) return null;
    // Verification is NOT checked here. An unverified doctor has to be able to
    // sign in and upload credentials; what they cannot reach is the doctor
    // experience, gated per route by M-05's `@VerifiedDoctorsOnly()`.
    assertDoctorSignInAllowed(doctor.verificationStatus);
    return { type: 'doctor', id: doctor.id };
  }

  /**
   * *** REVOCATION ***  One increment refuses every token ever issued for this
   * account, on every device, immediately. It is what signing out, suspending
   * an account and deleting one all do, and it is the whole of FR-1.8.
   *
   * The push token goes with it: FR-1.8 requires revocation to stop
   * notification delivery, and a signed-out device must not keep receiving
   * another person's alerts if the handset changes hands.
   */
  async revokeAllTokens(actor: AuthenticatedActor): Promise<void> {
    if (actor.type === 'patient') {
      await this.prisma.patient.update({
        where: { id: actor.id },
        data: { tokenVersion: { increment: 1 }, pushToken: null, deviceId: null },
      });
      return;
    }
    if (actor.type === 'doctor') {
      await this.prisma.doctor.update({
        where: { id: actor.id },
        data: { tokenVersion: { increment: 1 }, pushToken: null, deviceId: null },
      });
      return;
    }
    if (actor.type === 'admin') {
      // Admins have no push token - SRS 2.3 puts the panel in a desktop browser.
      await this.prisma.admin.update({
        where: { id: actor.id },
        data: { tokenVersion: { increment: 1 } },
      });
    }
  }

  /** Records the device this sign-in will be notified on (FR-1.8). */
  async setPatientDevice(
    patientId: string,
    device: { pushToken?: string; deviceId?: string },
  ): Promise<void> {
    if (!device.pushToken && !device.deviceId) return;
    await this.prisma.patient.update({
      where: { id: patientId },
      data: {
        ...(device.pushToken ? { pushToken: device.pushToken } : {}),
        ...(device.deviceId ? { deviceId: device.deviceId } : {}),
      },
    });
  }

  /** Shapes an account row for `TokensService.issue`. */
  static subject(
    type: AuthenticatedActor['type'],
    row: { id: string; tokenVersion: number; permissionLevel?: string },
  ): TokenSubject {
    return {
      id: row.id,
      type,
      tokenVersion: row.tokenVersion,
      ...(row.permissionLevel ? { level: row.permissionLevel as AdminPermissionLevel } : {}),
    };
  }
}

/**
 * `pending` signs in: a patient row is written at OTP verification and only
 * becomes `active` once the profile is filled in (M-04). Suspension and
 * deletion are the states that refuse.
 */
export function assertSignInAllowed(status: AccountStatus): void {
  if (status === AccountStatus.suspended || status === AccountStatus.deleted) {
    throw new AppException(
      IdentityError.ACCOUNT_NOT_ACTIVE,
      'This account is no longer active. Please contact support.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Who may sign in to the doctor app.
 *
 * `pending` and `under_review` MUST be allowed: uploading credentials and
 * reading what an admin rejected is precisely what an unverified doctor is
 * here to do. What they cannot do is consult - that gate is
 * `@VerifiedDoctorsOnly()` in M-05, checked per route on the row itself.
 *
 * `rejected` MUST be allowed too: a doctor whose application was turned down
 * signs in to read the admin's reason, correct their details and resubmit.
 * Locking them out left them with no way to learn why. They cannot consult
 * either - the per-route `@VerifiedDoctorsOnly()` gate checks the row itself.
 *
 * `suspended` is refused, and suspension has already bumped `token_version`,
 * so any token they still hold is dead as well.
 */
export function assertDoctorSignInAllowed(status: DoctorVerificationStatus): void {
  if (status === DoctorVerificationStatus.suspended) {
    throw new AppException(
      IdentityError.ACCOUNT_NOT_ACTIVE,
      'This account is no longer active. Please contact the Coracure team.',
      HttpStatus.FORBIDDEN,
    );
  }
}

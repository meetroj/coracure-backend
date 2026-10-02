import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AccountStatus, Gender } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppException, PlatformError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import {
  ageFrom,
  formatDateOfBirth,
  initialsOf,
  isPlausibleDateOfBirth,
  parseDateOfBirth,
} from './date-of-birth';
import { RegionsService } from '../catalogue/regions.service';
import { PATIENT_ASSIGNMENT, PatientAssignment } from './patient-assignment';
import { PatientsError } from './patients.errors';

/** What a patient sees of themselves. FR-2.2, plus the completeness flag the app routes on. */
export interface OwnProfile {
  id: string;
  fullName: string | null;
  /** `YYYY-MM-DD`. The app renders `age` and rarely shows this. */
  dateOfBirth: string | null;
  /** DERIVED from dateOfBirth, never stored. Null until a date of birth is given. */
  age: number | null;
  gender: Gender;
  preferredLanguage: string;
  /** The state the patient is in. Null until they set one; see FR-20.10. */
  regionId: string | null;
  /** The sign-in identifier. Read-only - see `update`. */
  mobileNumber: string;
  status: AccountStatus;
  /** False while FR-2.2's basic profile is still missing something. */
  isComplete: boolean;
}

/**
 * What a treating doctor sees. FR-9.2 puts INITIALS, age and gender on the
 * appointment card - not a name. The card is a list on a screen other people
 * can see over a shoulder, and the doctor has the full clinical record inside
 * the consultation itself.
 */
export interface PatientCard {
  id: string;
  initials: string | null;
  age: number | null;
  gender: Gender;
  preferredLanguage: string;
}

export interface ProfileUpdate {
  fullName?: string;
  dateOfBirth?: string;
  gender?: Gender;
  preferredLanguage?: string;
  regionId?: string;
}

/**
 * M-04 Patient Profile. Owns NO table - the profile is columns on the
 * `patients` row that M-02 owns. Every other module reads a patient through
 * here, so the rule about who may see what has one home.
 */
@Injectable()
export class PatientProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PATIENT_ASSIGNMENT) private readonly assignment: PatientAssignment,
    private readonly regions: RegionsService,
  ) {}

  /** The patient's own profile. */
  async getOwn(patientId: string): Promise<OwnProfile> {
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) {
      throw new AppException('NOT_FOUND', 'That patient does not exist.', HttpStatus.NOT_FOUND);
    }
    return shape(patient);
  }

  /**
   * Edits the profile. `mobileNumber` is deliberately not editable: it is the
   * sign-in identifier, and changing it is an OTP re-verification flow no
   * requirement asks for. A patient who changes number signs up again.
   *
   * Completing the profile is what moves the account from `pending` to
   * `active`. That is the only thing that does, which is why the transition
   * lives here rather than in M-02 where the row is created.
   */
  async update(patientId: string, input: ProfileUpdate): Promise<OwnProfile> {
    const before = await this.prisma.patient.findUnique({ where: { id: patientId } });
    if (!before) {
      throw new AppException('NOT_FOUND', 'That patient does not exist.', HttpStatus.NOT_FOUND);
    }

    let dateOfBirth: Date | undefined;
    if (input.dateOfBirth !== undefined) {
      const parsed = parseDateOfBirth(input.dateOfBirth);
      if (!parsed || !isPlausibleDateOfBirth(parsed)) {
        throw new AppException(
          PatientsError.INVALID_DATE_OF_BIRTH,
          'Enter a real date of birth in the past, as YYYY-MM-DD.',
          HttpStatus.BAD_REQUEST,
        );
      }
      dateOfBirth = parsed;
    }

    // A region that has been retired must not become somebody's preference:
    // assignment would match on a pool nobody is in.
    if (input.regionId !== undefined) await this.regions.assertUsable(input.regionId);

    const patch = {
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.preferredLanguage !== undefined
        ? { preferredLanguage: input.preferredLanguage }
        : {}),
      ...(input.regionId !== undefined ? { regionId: input.regionId } : {}),
    };

    // Promote on completion, but never demote: an active account whose name is
    // cleared is an edit to fix, not a reason to lock them out mid-treatment.
    const willBeComplete = isComplete({ ...before, ...patch });
    const promote = before.status === AccountStatus.pending && willBeComplete;

    const updated = await this.prisma.patient.update({
      where: { id: patientId },
      data: { ...patch, ...(promote ? { status: AccountStatus.active } : {}) },
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'update',
      entityType: 'patient_profile',
      entityId: patientId,
      // The changed FIELDS, not the values: this is a clinical platform and the
      // audit log is read by admins who have no business seeing a date of birth
      // they did not otherwise need.
      metadata: { fields: Object.keys(patch), promotedToActive: promote },
    });

    return shape(updated);
  }

  /**
   * The card a treating doctor sees (FR-9.2). Refused unless a consultation
   * ties the two together - SRS 6.2, "a doctor sees only assigned patients".
   */
  async getCardForDoctor(doctorId: string, patientId: string): Promise<PatientCard> {
    const treating = await this.assignment.isDoctorTreating(doctorId, patientId);
    if (!treating) {
      throw new AppException(
        PlatformError.FORBIDDEN,
        'You do not have access to this patient.',
        HttpStatus.FORBIDDEN,
      );
    }

    const patient = await this.prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) {
      throw new AppException('NOT_FOUND', 'That patient does not exist.', HttpStatus.NOT_FOUND);
    }

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'read',
      entityType: 'patient_profile',
      entityId: patientId,
    });

    return {
      id: patient.id,
      initials: initialsOf(patient.fullName),
      age: patient.dateOfBirth ? ageFrom(patient.dateOfBirth) : null,
      gender: patient.gender,
      preferredLanguage: patient.preferredLanguage,
    };
  }
}

/** FR-2.2's basic profile. Gender and language always have a value, so these two decide it. */
function isComplete(patient: { fullName: string | null; dateOfBirth: Date | null }): boolean {
  return Boolean(patient.fullName?.trim()) && patient.dateOfBirth !== null;
}

function shape(patient: {
  id: string;
  fullName: string | null;
  dateOfBirth: Date | null;
  gender: Gender;
  preferredLanguage: string;
  regionId: string | null;
  mobileNumber: string;
  status: AccountStatus;
}): OwnProfile {
  return {
    id: patient.id,
    fullName: patient.fullName,
    dateOfBirth: patient.dateOfBirth ? formatDateOfBirth(patient.dateOfBirth) : null,
    age: patient.dateOfBirth ? ageFrom(patient.dateOfBirth) : null,
    gender: patient.gender,
    preferredLanguage: patient.preferredLanguage,
    regionId: patient.regionId,
    mobileNumber: patient.mobileNumber,
    status: patient.status,
    isComplete: isComplete(patient),
  };
}

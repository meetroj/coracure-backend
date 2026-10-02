import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  Doctor,
  DoctorDocumentType,
  DocumentReviewStatus,
  DoctorPresence,
  DoctorSeniority,
  DoctorVerificationStatus,
  Prisma,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { EventBus } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { CREDENTIAL_STORAGE, CredentialStorage } from './credential-storage';
import { AccountsService } from '../identity/accounts.service';
import { PATIENT_ASSIGNMENT, PatientAssignment } from '../patients/patient-assignment';
import { DOCTOR_METRICS, DoctorMetrics, DoctorReliability } from './doctor-metrics';
import { DoctorsError } from './doctors.errors';
import { SPECIALTY_CATALOGUE, SpecialtyCatalogue } from './specialty-catalogue';

declare module '../common/event-bus' {
  interface PlatformEvents {
    /** An admin created the account. The doctor cannot consult yet. */
    'doctor.created': { doctorId: string; createdByAdminId: string };
    /** Every required credential is approved and an admin has signed the doctor off. */
    'doctor.verified': { doctorId: string; verifiedByAdminId: string };
    /** Bookability changed. A delisted doctor keeps their diary and their history. */
    'doctor.listing_changed': { doctorId: string; isListed: boolean };
    /** No longer allowed to sign in. Every token for the account is already dead. */
    'doctor.suspended': { doctorId: string; suspendedByAdminId: string };
  }
}

/** What an admin sees. Everything on the row except the token and push state. */
/**
 * The three things a scheduler needs about a provider, for a whole pool at
 * once. Added for M-07: the FR-10.7 admin view and assignment both ask about
 * every candidate at one instant, and `getAccount` per candidate would be a
 * query each. It stays here rather than in M-07 because `doctors` is M-05's.
 */
export interface DoctorBookingProfile {
  id: string;
  consultationDurationMinutes: number;
  bufferMinutes: number;
  /** Verified AND listed. An unbookable provider is never assigned, however free their diary. */
  isBookable: boolean;
}

export interface DoctorAccount {
  id: string;
  fullName: string;
  mobileNumber: string;
  /** Null until an OTP sign-in proves somebody holds that number. */
  mobileVerifiedAt: Date | null;
  bio: string | null;
  languages: string[];
  verificationStatus: DoctorVerificationStatus;
  registrationNumber: string | null;
  qualification: string | null;
  yearsOfExperience: number | null;
  verifiedByAdminId: string | null;
  verifiedAt: Date | null;
  seniorityLevel: DoctorSeniority;
  specialtyId: string | null;
  /// *** WHAT THIS PROVIDER IS PAID *** - not what the patient is charged.
  payoutFeeInr: number;
  consultationDurationMinutes: number;
  bufferMinutes: number;
  isListed: boolean;
  allowInstantConsult: boolean;
  /** Admin-set once payout details are checked outside this system. */
  bankVerified: boolean;
  presence: DoctorPresence;
  /** FR-10.5: set while documentation from an instant consult is outstanding. */
  isBlockedByCompletionGate: boolean;
  /** The current APPROVED `profile_photo` credential, signed fresh on every read. Null until one exists. */
  photoUrl: string | null;
  createdAt: Date;
}

/**
 * What a patient sees of the provider ASSIGNED to them (FR-4.3). Never the
 * mobile number, and never one option among several - since SRS 1.2 a patient
 * does not choose a provider, so there is no browsable version of this.
 */
export interface DoctorListing {
  id: string;
  fullName: string;
  qualification: string | null;
  registrationNumber: string | null;
  yearsOfExperience: number | null;
  languages: string[];
  bio: string | null;
  specialtyId: string | null;
  /// What the PATIENT pays, read from the specialty (FR-7.8). Null while the
  /// provider has no specialty set, because there is no service to price.
  consultationFeeInr: number | null;
  consultationDurationMinutes: number;
  seniorityLevel: DoctorSeniority;
  presence: DoctorPresence;
  allowInstantConsult: boolean;
  /** Admin-set once payout details are checked outside this system. */
  bankVerified: boolean;
  /** The current APPROVED `profile_photo` credential, signed fresh on every read. Null until one exists. */
  photoUrl: string | null;
  /** FR-4.3: taken from the SPECIALTY, never set on the doctor. */
  canPrescribe: boolean;
}

/** The doctor's own view. Adds what only they need to see about themselves. */
export interface DoctorSelfProfile extends DoctorListing {
  mobileNumber: string;
  verificationStatus: DoctorVerificationStatus;
  isListed: boolean;
  bufferMinutes: number;
  /** True only when verified AND listed - what the doctor app routes on. */
  isBookable: boolean;
}

export interface CreateDoctorInput {
  mobileNumber: string;
  fullName: string;
  specialtyId?: string;
  qualification?: string;
  registrationNumber?: string;
  yearsOfExperience?: number;
  languages?: string[];
  /** What this provider is PAID. The patient price is the specialty's. */
  payoutFeeInr?: number;
  consultationDurationMinutes?: number;
  bufferMinutes?: number;
  bio?: string;
}

/** The fields an admin may set. Fee and specialty are admin-only for a reason. */
export interface AdminDoctorPatch {
  fullName?: string;
  bio?: string;
  languages?: string[];
  qualification?: string;
  registrationNumber?: string;
  yearsOfExperience?: number;
  specialtyId?: string | null;
  /** What this provider is PAID. The patient price is the specialty's. */
  payoutFeeInr?: number;
  consultationDurationMinutes?: number;
  bufferMinutes?: number;
  allowInstantConsult?: boolean;
  /** Set once the admin has checked payout details outside this system. */
  bankVerified?: boolean;
}

/** What the doctor may change about themselves. Not their fee, not their specialty. */
export interface DoctorSelfPatch {
  bio?: string;
  languages?: string[];
  consultationDurationMinutes?: number;
  bufferMinutes?: number;
}

/**
 * The admin roster's filters. There is no `maxFeeInr` and no sort by fee: the
 * patient price is a property of the specialty now, and nobody browses
 * providers by cost because nobody chooses one.
 */
export interface DoctorListFilter {
  specialtyId?: string;
  language?: string;
  regionId?: string;
  seniorityLevel?: DoctorSeniority;
  sort?: 'experience_desc' | 'name';
  limit?: number;
  offset?: number;
}

export interface AdminDoctorListFilter extends DoctorListFilter {
  verificationStatus?: DoctorVerificationStatus;
  isListed?: boolean;
  search?: string;
}

/**
 * M-05 Doctor Registry. Owns the `doctors` row: the account, the profile, the
 * fee, the permissions and the listing state.
 *
 * Verification itself is next door in `DoctorVerificationService`, because
 * approving credentials one at a time is a different job from editing a
 * profile - and because the rule "listed requires verified" then has exactly
 * one place to live.
 */
@Injectable()
export class DoctorRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly accounts: AccountsService,
    @Inject(SPECIALTY_CATALOGUE) private readonly specialties: SpecialtyCatalogue,
    @Inject(DOCTOR_METRICS) private readonly metrics: DoctorMetrics,
    @Inject(PATIENT_ASSIGNMENT) private readonly assignment: PatientAssignment,
    @Inject(CREDENTIAL_STORAGE) private readonly credentials: CredentialStorage,
  ) {}

  // -- Creation -------------------------------------------------------------

  /**
   * FR-1.2: an admin creates the account, and there is no self sign-up path at
   * all. The doctor exists as `pending` from this moment - they can sign in on
   * the number below and upload credentials, and nothing else.
   */
  async create(input: CreateDoctorInput, actor: AuthenticatedActor): Promise<DoctorAccount> {
    let created: Doctor;
    try {
      created = await this.prisma.doctor.create({
        data: {
          mobileNumber: input.mobileNumber,
          fullName: input.fullName.trim(),
          ...(input.specialtyId ? { specialtyId: input.specialtyId } : {}),
          ...(input.qualification ? { qualification: input.qualification } : {}),
          ...(input.registrationNumber ? { registrationNumber: input.registrationNumber } : {}),
          ...(input.yearsOfExperience !== undefined
            ? { yearsOfExperience: input.yearsOfExperience }
            : {}),
          ...(input.languages ? { languages: input.languages } : {}),
          ...(input.payoutFeeInr !== undefined
            ? { consultationFeeInr: new Prisma.Decimal(input.payoutFeeInr) }
            : {}),
          ...(input.consultationDurationMinutes !== undefined
            ? { consultationDurationMinutes: input.consultationDurationMinutes }
            : {}),
          ...(input.bufferMinutes !== undefined ? { bufferMinutes: input.bufferMinutes } : {}),
          ...(input.bio ? { bio: input.bio } : {}),
        },
      });
    } catch (error) {
      throw asConflict(error);
    }

    // Who created the account is this entry, which is why `doctors` has no
    // `created_by` column.
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'doctor',
      entityId: created.id,
      metadata: { mobileNumber: input.mobileNumber, specialtyId: input.specialtyId ?? null },
    });
    this.events.publish('doctor.created', { doctorId: created.id, createdByAdminId: actor.id });

    return toAccount(created, await this.photoUrlOf(created.id));
  }

  // -- Reads ----------------------------------------------------------------

  /** The admin view of one doctor. */
  async getAccount(doctorId: string): Promise<DoctorAccount> {
    const doctor = await this.require(doctorId);
    return toAccount(doctor, await this.photoUrlOf(doctor.id));
  }

  /** FR-18.6's reliability block, counted from consultations rather than stored. */
  reliabilityOf(doctorId: string): Promise<DoctorReliability> {
    return this.metrics.reliabilityOf(doctorId);
  }

  /** The doctor's own profile, including how far through verification they are. */
  async getSelfProfile(doctorId: string): Promise<DoctorSelfProfile> {
    const doctor = await this.require(doctorId);
    return {
      ...(await this.toListing(doctor)),
      mobileNumber: doctor.mobileNumber,
      verificationStatus: doctor.verificationStatus,
      isListed: doctor.isListed,
      bufferMinutes: doctor.bufferMinutes,
      isBookable: isBookable(doctor),
    };
  }

  /**
   * The patient-facing profile (FR-4.3): the provider ASSIGNED to this patient,
   * and nobody else.
   *
   * The Telemedicine Practice Guidelines require a patient to know who they are
   * consulting. They do not require, and SRS 1.2 does not permit, reading the
   * profile of a provider who is not treating them - so this reuses M-04's
   * assignment port, which refuses everyone until M-11 supplies the real
   * lookup. An access rule that is not implemented yet must refuse, not allow.
   */
  async getAssignedListing(doctorId: string, patientId: string): Promise<DoctorListing> {
    const treating = await this.assignment.isDoctorTreating(doctorId, patientId);
    if (!treating) {
      // Not a 403: to a patient they are not treating, a provider's profile
      // does not exist. A 403 would confirm the id belongs to somebody.
      throw notFound();
    }
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) throw notFound();
    return this.toListing(doctor);
  }

  /** The same shape, for a module that has already established the right to read it. */
  async getListingFor(doctorId: string): Promise<DoctorListing> {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) throw notFound();
    return this.toListing(doctor);
  }

  /**
   * *** THERE IS NO BOOKABLE DIRECTORY. ***
   *
   * SRS 1.2 removed patient-led provider selection: a patient picks a service
   * and the system assigns someone (FR-4.2). A method here that returned a
   * filtered, sorted list of providers would be the shape of the screen that no
   * longer exists, and the first thing to be quietly reintroduced.
   *
   * What replaced it: `GET /services` in M-06 for choosing, M-11's assignment
   * for picking a person, and `getListing` below for reading the one assigned.
   */

  /** The admin roster, which unlike the directory shows every state. */
  async listForAdmin(filter: AdminDoctorListFilter): Promise<DoctorAccount[]> {
    const doctors = await this.prisma.doctor.findMany({
      where: {
        ...(filter.verificationStatus ? { verificationStatus: filter.verificationStatus } : {}),
        ...(filter.isListed !== undefined ? { isListed: filter.isListed } : {}),
        ...(filter.search
          ? {
              OR: [
                { fullName: { contains: filter.search, mode: 'insensitive' as const } },
                { mobileNumber: { contains: filter.search } },
                { registrationNumber: { contains: filter.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...whereFrom(filter),
      },
      orderBy: orderFrom(filter.sort ?? 'name'),
      take: Math.min(filter.limit ?? 50, 200),
      skip: filter.offset ?? 0,
    });
    return Promise.all(doctors.map(async (doctor) => toAccount(doctor, await this.photoUrlOf(doctor.id))));
  }

  /**
   * FR-4.3's prescribing gate, for M-15. Read from the doctor's SPECIALTY, so
   * a psychiatrist prescribes medicines while a psychologist, therapist or
   * counsellor issues advice and a therapy plan only. There is no column for it
   * on the doctor row, because a column there could disagree with the specialty.
   */
  async canPrescribe(doctorId: string): Promise<boolean> {
    const doctor = await this.require(doctorId);
    return this.specialties.canPrescribe(doctor.specialtyId);
  }

  /**
   * The bookability check every other module calls. A doctor who is not
   * verified and listed cannot be booked, cannot be routed an instant request
   * and cannot appear in a search result.
   */
  async assertBookable(doctorId: string): Promise<void> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { verificationStatus: true, isListed: true },
    });
    if (!doctor) throw notFound();
    if (!isBookable(doctor)) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_VERIFIED,
        'This doctor is not available for consultations.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Slot length and bookability for a set of providers, in one query. Providers
   * that do not exist are simply absent from the map - a scheduler asking about
   * a stale pool wants the ones that are real, not an exception.
   */
  async bookingProfilesOf(doctorIds: string[]): Promise<Map<string, DoctorBookingProfile>> {
    if (doctorIds.length === 0) return new Map();
    const rows = await this.prisma.doctor.findMany({
      where: { id: { in: doctorIds } },
      select: {
        id: true,
        consultationDurationMinutes: true,
        bufferMinutes: true,
        verificationStatus: true,
        isListed: true,
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          consultationDurationMinutes: row.consultationDurationMinutes,
          bufferMinutes: row.bufferMinutes,
          isBookable: isBookable(row),
        },
      ]),
    );
  }

  // -- Edits ----------------------------------------------------------------

  /** FR-18.1: the admin edits the profile, the fee and the instant permission. */
  async updateAsAdmin(
    doctorId: string,
    patch: AdminDoctorPatch,
    actor: AuthenticatedActor,
  ): Promise<DoctorAccount> {
    await this.require(doctorId);
    const data: Prisma.DoctorUpdateInput = {
      ...(patch.fullName !== undefined ? { fullName: patch.fullName.trim() } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      ...(patch.languages !== undefined ? { languages: patch.languages } : {}),
      ...(patch.qualification !== undefined ? { qualification: patch.qualification } : {}),
      ...(patch.registrationNumber !== undefined
        ? { registrationNumber: patch.registrationNumber }
        : {}),
      ...(patch.yearsOfExperience !== undefined
        ? { yearsOfExperience: patch.yearsOfExperience }
        : {}),
      ...(patch.specialtyId !== undefined ? { specialtyId: patch.specialtyId } : {}),
      ...(patch.payoutFeeInr !== undefined
        ? { consultationFeeInr: new Prisma.Decimal(patch.payoutFeeInr) }
        : {}),
      ...(patch.consultationDurationMinutes !== undefined
        ? { consultationDurationMinutes: patch.consultationDurationMinutes }
        : {}),
      ...(patch.bufferMinutes !== undefined ? { bufferMinutes: patch.bufferMinutes } : {}),
      ...(patch.allowInstantConsult !== undefined
        ? { allowInstantConsult: patch.allowInstantConsult }
        : {}),
      ...(patch.bankVerified !== undefined ? { bankVerified: patch.bankVerified } : {}),
    };

    let updated: Doctor;
    try {
      updated = await this.prisma.doctor.update({ where: { id: doctorId }, data });
    } catch (error) {
      throw asConflict(error);
    }

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor',
      entityId: doctorId,
      // The fee and the instant permission are recorded with their VALUES:
      // both are decisions about money and access an admin may be asked to
      // account for. The rest is the field list, as everywhere else.
      metadata: {
        fields: Object.keys(data),
        ...(patch.payoutFeeInr !== undefined ? { payoutFeeInr: patch.payoutFeeInr } : {}),
        ...(patch.allowInstantConsult !== undefined
          ? { allowInstantConsult: patch.allowInstantConsult }
          : {}),
        ...(patch.bankVerified !== undefined ? { bankVerified: patch.bankVerified } : {}),
      },
    });
    return toAccount(updated, await this.photoUrlOf(updated.id));
  }

  /**
   * What the doctor may change themselves. Their qualification, registration
   * number, specialty and fee are NOT here: those are the facts an admin
   * verified, and a doctor who could edit them after approval would make the
   * approval meaningless.
   */
  async updateSelf(doctorId: string, patch: DoctorSelfPatch): Promise<DoctorSelfProfile> {
    await this.require(doctorId);
    const data = {
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      ...(patch.languages !== undefined ? { languages: patch.languages } : {}),
      ...(patch.consultationDurationMinutes !== undefined
        ? { consultationDurationMinutes: patch.consultationDurationMinutes }
        : {}),
      ...(patch.bufferMinutes !== undefined ? { bufferMinutes: patch.bufferMinutes } : {}),
    };
    await this.prisma.doctor.update({ where: { id: doctorId }, data });

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: 'doctor',
      entityId: doctorId,
      metadata: { fields: Object.keys(data) },
    });
    return this.getSelfProfile(doctorId);
  }

  // -- Permissions ----------------------------------------------------------

  /**
   * FR-1.6: expert level, granted and revoked by an admin. It makes a doctor
   * ELIGIBLE to be asked for a case opinion and grants sight of nothing on its
   * own - seeing a case still requires that case to be assigned to them (M-17).
   */
  async setSeniority(
    doctorId: string,
    level: DoctorSeniority,
    actor: AuthenticatedActor,
  ): Promise<DoctorAccount> {
    const before = await this.require(doctorId);
    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { seniorityLevel: level },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_seniority',
      entityId: doctorId,
      metadata: { from: before.seniorityLevel, to: level },
    });
    return toAccount(updated, await this.photoUrlOf(updated.id));
  }

  /**
   * The second of the two admin actions. Verification says the papers are in
   * order; listing says the client wants patients to see this doctor. A
   * database CHECK refuses listing anyone unverified, so the rule cannot be
   * bypassed by a query, an admin action or a later module.
   */
  async setListed(
    doctorId: string,
    isListed: boolean,
    actor: AuthenticatedActor,
  ): Promise<DoctorAccount> {
    const doctor = await this.require(doctorId);
    if (isListed && doctor.verificationStatus !== DoctorVerificationStatus.verified) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_VERIFIED,
        'Verify this doctor before listing them.',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { isListed },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_listing',
      entityId: doctorId,
      metadata: { isListed },
    });
    this.events.publish('doctor.listing_changed', { doctorId, isListed });
    return toAccount(updated, await this.photoUrlOf(updated.id));
  }

  // -- Region pools ---------------------------------------------------------

  /**
   * *** THE REGION POOL *** (SRS 18.9). Which states this provider serves.
   *
   * Set as a whole rather than added one at a time: the admin screen is a list
   * of checkboxes, and replacing the set in a transaction means a half-applied
   * edit cannot leave a provider in a region they were being taken out of.
   */
  async setRegions(
    doctorId: string,
    regionIds: string[],
    actor: AuthenticatedActor,
  ): Promise<string[]> {
    await this.require(doctorId);
    const wanted = [...new Set(regionIds)];

    await this.prisma.$transaction([
      this.prisma.doctorRegion.deleteMany({
        where: { doctorId, ...(wanted.length ? { regionId: { notIn: wanted } } : {}) },
      }),
      this.prisma.doctorRegion.createMany({
        data: wanted.map((regionId) => ({ doctorId, regionId })),
        skipDuplicates: true,
      }),
    ]);

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_regions',
      entityId: doctorId,
      // The regions themselves, not just "changed": which patients can reach
      // this provider is exactly what this row decides.
      metadata: { regionIds: wanted },
    });
    return this.regionsOf(doctorId);
  }

  /** The regions this provider serves. */
  async regionsOf(doctorId: string): Promise<string[]> {
    const rows = await this.prisma.doctorRegion.findMany({
      where: { doctorId },
      select: { regionId: true },
    });
    return rows.map((row) => row.regionId);
  }

  // -- Suspension -----------------------------------------------------------

  /**
   * FR-18.1's "remove". It is a STATE, never a delete: the doctor row is
   * referenced by consultations, prescriptions and audit entries that must
   * outlive the account, so removing the row would take the clinical record
   * with it.
   *
   * Suspension does three things at once - refuses the account, takes the
   * doctor out of the directory, and kills every token they hold on every
   * device (FR-1.8).
   */
  async suspend(
    doctorId: string,
    reason: string,
    actor: AuthenticatedActor,
  ): Promise<DoctorAccount> {
    await this.require(doctorId);
    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data: {
        verificationStatus: DoctorVerificationStatus.suspended,
        isListed: false,
        presence: DoctorPresence.offline,
      },
    });
    await this.accounts.revokeAllTokens({ type: 'doctor', id: doctorId });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_verification',
      entityId: doctorId,
      metadata: { to: 'suspended', reason },
    });
    this.events.publish('doctor.suspended', { doctorId, suspendedByAdminId: actor.id });
    return toAccount(updated, await this.photoUrlOf(updated.id));
  }

  /**
   * Lifts a suspension. A doctor who was verified before goes back to verified;
   * one who never got that far goes back to `pending` and starts again. They do
   * NOT come back listed - putting a doctor in front of patients again is the
   * separate, deliberate second action.
   */
  async reinstate(doctorId: string, actor: AuthenticatedActor): Promise<DoctorAccount> {
    const doctor = await this.require(doctorId);
    if (doctor.verificationStatus !== DoctorVerificationStatus.suspended) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_APPROVED,
        'Only a suspended doctor can be reinstated.',
        HttpStatus.CONFLICT,
      );
    }

    const to = doctor.verifiedAt
      ? DoctorVerificationStatus.verified
      : DoctorVerificationStatus.pending;
    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { verificationStatus: to },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_verification',
      entityId: doctorId,
      metadata: { from: 'suspended', to },
    });
    return toAccount(updated, await this.photoUrlOf(updated.id));
  }

  // -- Internals ------------------------------------------------------------

  private async require(doctorId: string): Promise<Doctor> {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) throw notFound();
    return doctor;
  }

  private async toListing(doctor: Doctor): Promise<DoctorListing> {
    return {
      id: doctor.id,
      fullName: doctor.fullName,
      qualification: doctor.qualification,
      registrationNumber: doctor.registrationNumber,
      yearsOfExperience: doctor.yearsOfExperience,
      languages: languagesOf(doctor.languages),
      bio: doctor.bio,
      specialtyId: doctor.specialtyId,
      // The PATIENT price, from the service. `doctor.consultationFeeInr` is a
      // different number - what this provider is paid.
      consultationFeeInr: await this.specialties.patientFeeInr(doctor.specialtyId),
      consultationDurationMinutes: doctor.consultationDurationMinutes,
      seniorityLevel: doctor.seniorityLevel,
      presence: doctor.presence,
      allowInstantConsult: doctor.allowInstantConsult,
      bankVerified: doctor.bankVerified,
      photoUrl: await this.photoUrlOf(doctor.id),
      canPrescribe: await this.specialties.canPrescribe(doctor.specialtyId),
    };
  }

  /**
   * The current APPROVED `profile_photo` credential, signed fresh - the same
   * call `DoctorVerificationService.downloadUrl` makes, minus the audit entry:
   * a photo view is not a sensitive-document read, and every profile fetch
   * would otherwise flood the audit log.
   */
  private async photoUrlOf(doctorId: string): Promise<string | null> {
    const photo = await this.prisma.doctorDocument.findFirst({
      where: {
        doctorId,
        documentType: DoctorDocumentType.profile_photo,
        reviewStatus: DocumentReviewStatus.approved,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!photo) return null;
    const signed = await this.credentials.signDownload(photo.storageKey, photo.fileName);
    return signed.url;
  }
}

/** Verified AND listed. Two separate admin actions, and both are required. */
export function isBookable(doctor: {
  verificationStatus: DoctorVerificationStatus;
  isListed: boolean;
}): boolean {
  return doctor.verificationStatus === DoctorVerificationStatus.verified && doctor.isListed;
}

/** `languages` is jsonb; a CHECK keeps it an array, this keeps it strings. */
export function languagesOf(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toAccount(doctor: Doctor, photoUrl: string | null): DoctorAccount {
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    mobileNumber: doctor.mobileNumber,
    mobileVerifiedAt: doctor.mobileVerifiedAt,
    bio: doctor.bio,
    languages: languagesOf(doctor.languages),
    verificationStatus: doctor.verificationStatus,
    registrationNumber: doctor.registrationNumber,
    qualification: doctor.qualification,
    yearsOfExperience: doctor.yearsOfExperience,
    verifiedByAdminId: doctor.verifiedByAdminId,
    verifiedAt: doctor.verifiedAt,
    seniorityLevel: doctor.seniorityLevel,
    specialtyId: doctor.specialtyId,
    payoutFeeInr: Number(doctor.consultationFeeInr),
    consultationDurationMinutes: doctor.consultationDurationMinutes,
    bufferMinutes: doctor.bufferMinutes,
    isListed: doctor.isListed,
    allowInstantConsult: doctor.allowInstantConsult,
    bankVerified: doctor.bankVerified,
    presence: doctor.presence,
    isBlockedByCompletionGate: doctor.blockedByConsultationId !== null,
    photoUrl,
    createdAt: doctor.createdAt,
  };
}

function whereFrom(filter: DoctorListFilter): Prisma.DoctorWhereInput {
  return {
    ...(filter.specialtyId ? { specialtyId: filter.specialtyId } : {}),
    ...(filter.seniorityLevel ? { seniorityLevel: filter.seniorityLevel } : {}),
    // Answered by the GIN index on `languages`.
    ...(filter.language ? { languages: { array_contains: [filter.language] } } : {}),
    // The region pool, for an admin checking who serves where.
    ...(filter.regionId ? { regions: { some: { regionId: filter.regionId } } } : {}),
  };
}

function orderFrom(sort: DoctorListFilter['sort']): Prisma.DoctorOrderByWithRelationInput[] {
  switch (sort) {
    case 'experience_desc':
      return [{ yearsOfExperience: 'desc' }, { fullName: 'asc' }];
    default:
      return [{ fullName: 'asc' }];
  }
}

function notFound(): AppException {
  return new AppException(
    DoctorsError.DOCTOR_NOT_FOUND,
    'That doctor does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

/** The unique indexes on `mobile_number` and `registration_number`, as one answer. */
function asConflict(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'that identifier';
    return new AppException(
      DoctorsError.DOCTOR_ALREADY_EXISTS,
      `A doctor already exists with ${target}.`,
      HttpStatus.CONFLICT,
    );
  }
  return error;
}

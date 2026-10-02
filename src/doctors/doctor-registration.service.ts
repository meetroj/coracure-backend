import { HttpStatus, Injectable } from '@nestjs/common';
import { DoctorDocumentType, DoctorVerificationStatus, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AppException, PlatformError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DoctorsError } from './doctors.errors';
import { SaveRegistrationDto } from './dto/doctor.dto';

/**
 * The doctor's own onboarding: what they state about themselves for an admin
 * to verify. The DOCUMENTS are uploaded through `/me/doctor/credentials`
 * first; this only states the facts and points at those uploads.
 *
 * A patient never reads any of this. A save derives the two things a patient
 * IS shown - `qualification` (names only, "MBBS · MD Dermatology") and
 * `yearsOfExperience` (the total only) - so the listing stays in step.
 */
export interface RegistrationView {
  fullName: string;
  dateOfBirth: string | null;
  gender: 'male' | 'female' | 'other' | 'undisclosed' | null;
  email: string | null;
  /** Medical council / professional registration number, as the doctor stated it. */
  registrationNumber: string | null;
  /** The number itself is never returned - only enough to recognise it. */
  identity: { idType: string; idTypeName: string | null; numberLast4: string; abhaId: string | null } | null;
  qualifications: {
    basicQualification: string;
    pgSpecialisation: string | null;
    superSpecialisation: string | null;
    fellowship: string | null;
    degreeCertificateId: string | null;
    registrationCertificateId: string | null;
  } | null;
  experience: {
    id: string;
    designation: string;
    institution: string;
    years: number;
    documentId: string | null;
  }[];
  signatureDocumentId: string | null;
  totalExperienceYears: number;
  editable: boolean;
}

/** Once an admin has verified the account, what they verified cannot be rewritten. */
const LOCKED: DoctorVerificationStatus[] = [DoctorVerificationStatus.verified, DoctorVerificationStatus.suspended];

const blank = (s?: string) => s?.trim() || null;

@Injectable()
export class DoctorRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(doctorId: string): Promise<RegistrationView> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { experience: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!doctor) throw notFound();

    // The certificates are typed uploads, so the latest of each type is the one in force.
    const documents = await this.prisma.doctorDocument.findMany({
      where: {
        doctorId,
        documentType: {
          in: [DoctorDocumentType.degree_certificate, DoctorDocumentType.registration_certificate, DoctorDocumentType.signature],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, documentType: true },
    });
    const latest = (type: DoctorDocumentType) => documents.find((d) => d.documentType === type)?.id ?? null;

    const experience = doctor.experience.map((x) => ({
      id: x.id,
      designation: x.designation,
      institution: x.institution,
      years: Number(x.years),
      documentId: x.documentId,
    }));

    return {
      fullName: doctor.fullName,
      dateOfBirth: doctor.dateOfBirth ? doctor.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: doctor.gender,
      email: doctor.email,
      registrationNumber: doctor.registrationNumber,
      identity: doctor.idType
        ? {
            idType: doctor.idType,
            idTypeName: doctor.idTypeName,
            numberLast4: (doctor.idNumber ?? '').replace(/[\s-]/g, '').slice(-4),
            abhaId: doctor.abhaId,
          }
        : null,
      qualifications: doctor.basicQualification
        ? {
            basicQualification: doctor.basicQualification,
            pgSpecialisation: doctor.pgSpecialisation,
            superSpecialisation: doctor.superSpecialisation,
            fellowship: doctor.fellowship,
            degreeCertificateId: latest(DoctorDocumentType.degree_certificate),
            registrationCertificateId: latest(DoctorDocumentType.registration_certificate),
          }
        : null,
      experience,
      signatureDocumentId: latest(DoctorDocumentType.signature),
      totalExperienceYears: totalYears(experience.map((x) => x.years)),
      editable: !LOCKED.includes(doctor.verificationStatus),
    };
  }

  /**
   * *** A REPLACE, NOT A PATCH, for the lists. *** `experience` sent becomes
   * the whole of what is on file; a field left out is left alone.
   */
  async save(doctorId: string, input: SaveRegistrationDto): Promise<RegistrationView> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { verificationStatus: true, fullName: true },
    });
    if (!doctor) throw notFound();
    if (LOCKED.includes(doctor.verificationStatus)) {
      throw new AppException(
        DoctorsError.REGISTRATION_LOCKED,
        'Your registration has been verified and can no longer be edited here. Ask an administrator to change it.',
        HttpStatus.CONFLICT,
      );
    }

    await this.requireOwnDocuments(doctorId, [
      [input.qualifications?.degreeCertificateId, DoctorDocumentType.degree_certificate],
      [input.qualifications?.registrationCertificateId, DoctorDocumentType.registration_certificate],
      [input.signatureDocumentId, DoctorDocumentType.signature],
      ...(input.experience ?? []).map((x) => [x.documentId, DoctorDocumentType.experience_letter] as const),
    ]);

    const q = input.qualifications;
    const id = input.identity;
    const data: Prisma.DoctorUpdateInput = {
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: calendarDate(input.dateOfBirth) } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
      ...(input.registrationNumber !== undefined ? { registrationNumber: input.registrationNumber.trim() } : {}),
      // A rejected doctor's save IS the resubmission: back into the queue, the old reason cleared.
      ...(doctor.verificationStatus === DoctorVerificationStatus.rejected
        ? { verificationStatus: DoctorVerificationStatus.under_review, rejectionReason: null }
        : {}),
      ...(id
        ? {
            idType: id.idType,
            idTypeName: id.idType === 'other' ? blank(id.idTypeName) : null,
            idNumber: id.idNumber.trim(),
            abhaId: blank(id.abhaId),
          }
        : {}),
      ...(q
        ? {
            basicQualification: q.basicQualification.trim(),
            pgSpecialisation: blank(q.pgSpecialisation),
            superSpecialisation: blank(q.superSpecialisation),
            fellowship: blank(q.fellowship),
            // what a patient sees: the names only
            qualification: [q.basicQualification, q.pgSpecialisation, q.superSpecialisation, q.fellowship]
              .map((n) => n?.trim())
              .filter(Boolean)
              .join(' · ')
              .slice(0, 255),
          }
        : {}),
      ...(input.experience ? { yearsOfExperience: Math.floor(totalYears(input.experience.map((x) => x.years))) } : {}),
    };

    try {
      await this.writeAll(doctorId, data, input);
    } catch (error) {
      // `registration_number` is unique: two doctors cannot hold the same council number.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          DoctorsError.DOCTOR_ALREADY_EXISTS,
          'That registration number is already on another account.',
          HttpStatus.CONFLICT,
          { field: 'registrationNumber' },
        );
      }
      throw error;
    }

    // Tell the review team. Sent on every save while unverified, so a resubmission
    // announces itself too. ponytail: one notice per save, dedupe if admins find it noisy.
    await this.notifications.notifyAdmins(['clinical_governance', 'operations'], {
      code: 'doctor_application_submitted',
      variables: { doctorName: (input.fullName ?? doctor.fullName).trim() || 'A new provider' },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: 'doctor',
      entityId: doctorId,
      // the field NAMES only - never an ID number or date of birth in an audit row
      metadata: { fields: Object.keys(input), registration: true },
    });
    return this.get(doctorId);
  }

  /** The doctor row and the replaced experience list, in one transaction. */
  private async writeAll(doctorId: string, data: Prisma.DoctorUpdateInput, input: SaveRegistrationDto) {
    await this.prisma.$transaction(async (tx) => {
      await tx.doctor.update({ where: { id: doctorId }, data });
      if (input.experience) {
        await tx.doctorExperience.deleteMany({ where: { doctorId } });
        if (input.experience.length) {
          await tx.doctorExperience.createMany({
            data: input.experience.map((x, i) => ({
              doctorId,
              designation: x.designation.trim(),
              institution: x.institution.trim(),
              years: x.years,
              documentId: x.documentId ?? null,
              sortOrder: i,
            })),
          });
        }
      }
    });
  }

  /** Every referenced upload must be this doctor's own, and of the type it is cited as. */
  private async requireOwnDocuments(doctorId: string, refs: (readonly [string | undefined, DoctorDocumentType])[]) {
    const wanted = refs.filter((r): r is readonly [string, DoctorDocumentType] => !!r[0]);
    if (!wanted.length) return;
    const found = await this.prisma.doctorDocument.findMany({
      where: { doctorId, id: { in: wanted.map(([docId]) => docId) } },
      select: { id: true, documentType: true },
    });
    for (const [docId, type] of wanted) {
      // Not a 403: to this doctor, another doctor's document does not exist.
      if (!found.some((d) => d.id === docId && d.documentType === type)) {
        throw new AppException(
          DoctorsError.DOCUMENT_NOT_FOUND,
          'One of the documents referenced was not found. Upload it again.',
          HttpStatus.NOT_FOUND,
          { documentId: docId, expectedType: type },
        );
      }
    }
  }
}

/** Years stated per role, summed - to one decimal, as entered. */
export const totalYears = (years: number[]) => Math.round(years.reduce((sum, y) => sum + y, 0) * 10) / 10;

/** `YYYY-MM-DD` that is a real date (no 30 February), or a 400. */
const calendarDate = (value: string): Date => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AppException(PlatformError.VALIDATION_FAILED, 'Enter a real date of birth.', HttpStatus.BAD_REQUEST, {
      field: 'dateOfBirth',
    });
  }
  return date;
};

const notFound = () => new AppException(DoctorsError.DOCTOR_NOT_FOUND, 'Doctor not found.', HttpStatus.NOT_FOUND);

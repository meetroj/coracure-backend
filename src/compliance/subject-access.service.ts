import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { ComplianceError } from './compliance.errors';

/**
 * Everything the platform holds about one person, in one document.
 *
 * The counterpart to erasure: SRS 6.4 covers deleting a patient's data, and a
 * data-rights regime that can delete but cannot show is half a regime. This is
 * the "give me everything you hold about me" answer.
 */
export interface SubjectAccessExport {
  generatedAt: Date;
  subject: {
    patientId: string;
    mobileNumber: string;
    fullName: string | null;
    dateOfBirth: Date | null;
    gender: string;
    preferredLanguage: string;
    accountCreated: Date;
  };
  consents: unknown[];
  consultations: unknown[];
  clinicalRecords: unknown[];
  payments: unknown[];
  files: unknown[];
  followUp: { plans: unknown[]; checkins: unknown[] };
  complaints: unknown[];
  notifications: unknown[];
  /**
   * What is NOT in this document, and why. Named rather than silently omitted:
   * a person asking what is held about them is owed the shape of the answer as
   * well as its contents.
   */
  notIncluded: Record<string, string>;
}

/**
 * SRS 6.4's other half. Owns nothing.
 *
 * *** IT READS. IT NEVER WRITES ANYTHING BUT ITS OWN AUDIT ENTRY. ***
 *
 * Every table here is somebody else's, and this assembles a copy rather than a
 * view - a subject access response is a document handed over at a moment in
 * time, not a live window into the platform.
 *
 * *** WHAT IS LEFT OUT IS A LEGAL QUESTION, NOT A TECHNICAL ONE. ***
 * Two things are excluded by default and both are flagged in `notIncluded` for
 * the client's counsel to rule on: an admin's internal notes on a complaint,
 * and de-identified clarification cases. Neither omission is silent, which is
 * the part this module can be responsible for.
 */
@Injectable()
export class SubjectAccessService {
  private readonly logger = new Logger(SubjectAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The patient's own copy.
   *
   * They ask for it themselves, which is the ordinary case: a data-rights
   * request that has to go through a support queue is one most people never
   * make.
   */
  async forSelf(actor: AuthenticatedActor): Promise<SubjectAccessExport> {
    if (actor.type !== 'patient') {
      throw new AppException(
        ComplianceError.NOT_PERMITTED,
        'This export is a patient’s own record of their data.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.assemble(actor.id, { type: 'patient', id: actor.id });
  }

  /**
   * The same document, produced by an admin answering a written request.
   *
   * Super admin only. It is the single widest read of one person's data in the
   * platform, and the level that can perform it should be the level that can
   * also authorise an erasure.
   */
  async forPatient(patientId: string, actor: AuthenticatedActor): Promise<SubjectAccessExport> {
    assertPermission(actor, 'super_admin');
    return this.assemble(patientId, { type: 'admin', id: actor.id });
  }

  private async assemble(
    patientId: string,
    by: { type: 'patient' | 'admin'; id: string },
  ): Promise<SubjectAccessExport> {
    const patient = await this.prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) {
      throw new AppException(
        ComplianceError.REQUEST_NOT_FOUND,
        'No such patient.',
        HttpStatus.NOT_FOUND,
      );
    }

    const [
      consents,
      consultations,
      clinicalRecords,
      payments,
      files,
      checkins,
      complaints,
      notifications,
    ] = await Promise.all([
      this.prisma.consent.findMany({
        where: { patientId },
        select: { documentType: true, acceptedAt: true, ipAddress: true },
      }),
      this.prisma.consultation.findMany({
        where: { patientId },
        orderBy: { createdAt: 'asc' },
        select: {
          referenceCode: true,
          mode: true,
          status: true,
          scheduledStartAt: true,
          durationMinutes: true,
          intakeAnswers: true,
          cancelledAt: true,
          cancellationReason: true,
          feedbackRating: true,
          feedbackComment: true,
          followupStartsOn: true,
          followupStatus: true,
          createdAt: true,
        },
      }),
      this.prisma.clinicalRecord.findMany({
        where: { consultation: { patientId } },
        select: {
          chiefComplaint: true,
          clinicalHistory: true,
          diagnosis: true,
          isDiagnosisProvisional: true,
          riskCategory: true,
          medicines: true,
          adviceCovered: true,
          adviceHomePractice: true,
          adviceNextFocus: true,
          adviceWarningSigns: true,
          referralNote: true,
          caseSummary: true,
          recommendedContentIds: true,
          finalisedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.payment.findMany({
        where: { consultation: { patientId } },
        select: {
          consultationFee: true,
          convenienceFee: true,
          gstAmount: true,
          status: true,
          paymentMethod: true,
          paidAt: true,
          refundAmount: true,
          refundReason: true,
          refundedAt: true,
          createdAt: true,
        },
      }),
      // The metadata, never the bytes. A file is fetched through its own
      // short-lived signed URL; putting object keys in a document that gets
      // emailed around would hand over durable pointers to private records.
      this.prisma.patientFile.findMany({
        // Not the soft-deleted ones. A document the patient removed is not data
        // the platform still holds about them, and listing it would answer the
        // question wrongly in the direction that alarms people.
        where: { patientId, deletedAt: null },
        select: { fileCategory: true, fileName: true, createdAt: true },
      }),
      this.prisma.checkinResponse.findMany({
        where: { consultation: { patientId } },
        orderBy: { checkinDate: 'asc' },
        select: { checkinDate: true, answers: true, status: true, submittedAt: true },
      }),
      this.prisma.complaint.findMany({
        where: { patientId },
        select: {
          referenceCode: true,
          category: true,
          subject: true,
          description: true,
          status: true,
          resolutionNote: true,
          resolvedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { templateCode: true, title: true, body: true, status: true, createdAt: true },
      }),
    ]);

    const followupPlans = consultations
      .filter((row) => row.followupStatus !== 'none')
      .map((row) => ({
        consultation: row.referenceCode,
        startsOn: row.followupStartsOn,
        status: row.followupStatus,
      }));

    await this.audit.record({
      actorType: by.type,
      actorId: by.id,
      action: 'export',
      entityType: 'subject_access',
      entityId: patientId,
      // WHAT was handed over, in shape rather than in content. Copying the
      // export into the trail would double every record it contains.
      metadata: {
        consultations: consultations.length,
        clinicalRecords: clinicalRecords.length,
        complaints: complaints.length,
        bySelf: by.type === 'patient',
      },
    });

    return {
      generatedAt: new Date(),
      subject: {
        patientId: patient.id,
        mobileNumber: patient.mobileNumber,
        fullName: patient.fullName,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        preferredLanguage: patient.preferredLanguage,
        accountCreated: patient.createdAt,
      },
      consents,
      consultations,
      clinicalRecords,
      payments,
      files,
      followUp: { plans: followupPlans, checkins },
      complaints,
      notifications,
      notIncluded: NOT_INCLUDED,
    };
  }
}

/**
 * *** THE OMISSIONS, NAMED. ***
 *
 * A person asking what is held about them is owed the shape of the answer as
 * well as its contents. Each of these is a decision the client's counsel should
 * confirm rather than one this module should make quietly - so they are stated
 * in the document itself, not buried in a comment nobody reads.
 */
const NOT_INCLUDED: Record<string, string> = {
  complaint_internal_notes:
    'Notes written by staff while handling a complaint are not included. Whether they form part of a subject access response is a question for the operator’s legal advice.',
  clarification_cases:
    'A case shared with an expert for a second opinion is de-identified before sharing and holds no reference to you, so there is nothing here that could be attributed to you.',
  audit_log:
    'The record of who accessed your data is retained for the configured retention period and can be produced on request. It is not included by default because it names staff as well as you.',
  file_contents:
    'Documents you uploaded are listed by name and date. The files themselves are downloaded from your own account, through a link that expires.',
};

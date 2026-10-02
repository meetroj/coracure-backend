import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  DoctorDocument,
  DoctorDocumentType,
  DocumentReviewStatus,
  DoctorVerificationStatus,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException, PlatformError } from '../common/errors';
import { EventBus } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CREDENTIAL_STORAGE,
  CredentialStorage,
  SignedUrl,
  credentialKey,
  keyBelongsToDoctor,
} from './credential-storage';
import { DoctorsError } from './doctors.errors';
import { SPECIALTY_CATALOGUE, SpecialtyCatalogue } from './specialty-catalogue';

/** One credential, as its owner and the reviewing admin both see it. */
export interface CredentialSummary {
  id: string;
  documentType: DoctorDocumentType;
  fileName: string;
  reviewStatus: DocumentReviewStatus;
  /** What the doctor has to act on. Null unless rejected. */
  rejectionReason: string | null;
  verifiedByAdminId: string | null;
  verifiedAt: Date | null;
  uploadedAt: Date;
}

/**
 * Where a doctor stands. Everything here is DERIVED from the documents and the
 * specialty's requirement list, so there is no "documents complete" column to
 * fall out of step with the rows it summarises.
 */
export interface VerificationProgress {
  doctorId: string;
  status: DoctorVerificationStatus;
  /** The admin's own words when the whole application was turned down. Null otherwise. */
  rejectionReason: string | null;
  /** What this doctor's specialty demands. */
  required: DoctorDocumentType[];
  /** Required and approved. */
  approved: DoctorDocumentType[];
  /** Required, and either never uploaded or still waiting on an admin. */
  outstanding: DoctorDocumentType[];
  /** Required, uploaded, and turned down. The doctor uploads a replacement. */
  rejected: DoctorDocumentType[];
  /**
   * FR-19.7: whether this provider's registration form demands a medical
   * council number. True for a doctor-form specialty, false for a non-doctor
   * one - a counsellor holds no council registration.
   */
  registrationNumberRequired: boolean;
  /** Required by the form AND not on the row yet. Blocks verification. */
  registrationNumberMissing: boolean;
  /** True when an admin is allowed to sign this doctor off. */
  readyForVerification: boolean;
  documents: CredentialSummary[];
}

export interface UploadRequest {
  documentType: DoctorDocumentType;
  fileName: string;
  contentType: string;
}

export interface ConfirmUpload {
  documentType: DoctorDocumentType;
  fileName: string;
  storageKey: string;
}

/**
 * Steps 2 to 4 of the five-step doctor flow: the doctor uploads credentials, an
 * admin approves or rejects EACH ONE separately with a reason, and only once
 * every credential the specialty requires is approved may an admin verify the
 * doctor.
 *
 * SRS section 8 puts verification of qualifications and registration on the
 * client. This module's job is to make that decision recorded, per document,
 * attributable and impossible to skip.
 */
@Injectable()
export class DoctorVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notifications: NotificationsService,
    @Inject(CREDENTIAL_STORAGE) private readonly storage: CredentialStorage,
    @Inject(SPECIALTY_CATALOGUE) private readonly specialties: SpecialtyCatalogue,
  ) {}

  // -- Upload ---------------------------------------------------------------

  /**
   * Hands the doctor a signed URL to PUT their file to. The key is minted here
   * from their own id, so a doctor cannot name a key that lands in another
   * doctor's folder, and no row is written until the upload is confirmed.
   */
  async requestUpload(
    doctorId: string,
    request: UploadRequest,
  ): Promise<{ storageKey: string; upload: SignedUrl }> {
    await this.requireDoctor(doctorId);
    const storageKey = credentialKey(doctorId, request.documentType, request.fileName);
    const upload = await this.storage.signUpload(storageKey, request.contentType);
    return { storageKey, upload };
  }

  /**
   * Writes the row once the file is in the object store. The key must be one
   * this service minted for THIS doctor - a key from anywhere else is refused,
   * so the confirm call cannot be used to attach somebody else's object.
   *
   * The first credential moves the doctor from `pending` to `under_review`:
   * that transition is the queue an admin works from, so it belongs to the
   * upload rather than to a separate "submit" the doctor might forget.
   */
  async confirmUpload(doctorId: string, input: ConfirmUpload): Promise<CredentialSummary> {
    const doctor = await this.requireDoctor(doctorId);
    if (!keyBelongsToDoctor(input.storageKey, doctorId)) {
      throw new AppException(
        DoctorsError.UPLOAD_NOT_RECOGNISED,
        'That upload does not belong to this account.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const document = await this.prisma.doctorDocument.create({
      data: {
        doctorId,
        documentType: input.documentType,
        storageKey: input.storageKey,
        fileName: input.fileName,
      },
    });

    if (doctor.verificationStatus === DoctorVerificationStatus.pending) {
      await this.prisma.doctor.update({
        where: { id: doctorId },
        data: { verificationStatus: DoctorVerificationStatus.under_review },
      });
    }

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'create',
      entityType: 'doctor_document',
      entityId: document.id,
      metadata: { documentType: input.documentType },
    });
    return toSummary(document);
  }

  // -- Reads ----------------------------------------------------------------

  /**
   * The doctor's own credential list and what is still outstanding, and the
   * same view an admin works the approval queue from.
   */
  async progressOf(doctorId: string): Promise<VerificationProgress> {
    const doctor = await this.requireDoctor(doctorId);
    const documents = await this.prisma.doctorDocument.findMany({
      where: { doctorId },
      orderBy: { createdAt: 'desc' },
    });
    const required = await this.specialties.requiredDocuments(doctor.specialtyId);

    // A type counts as approved if ANY upload of it was approved - a rejected
    // first attempt followed by an accepted second one is a satisfied
    // requirement, and the rejected row stays as history.
    const approvedTypes = new Set(
      documents
        .filter((document) => document.reviewStatus === DocumentReviewStatus.approved)
        .map((document) => document.documentType),
    );
    const rejectedTypes = new Set(
      documents
        .filter((document) => document.reviewStatus === DocumentReviewStatus.rejected)
        .map((document) => document.documentType),
    );

    const approved = required.filter((type) => approvedTypes.has(type));
    const outstanding = required.filter((type) => !approvedTypes.has(type));

    // *** FR-19.7, THE THIRD THING THE REGISTRATION FORM DECIDES. *** Approved
    // documents are not the whole of verification: a doctor-form provider must
    // also hold a medical council registration NUMBER on the row. SRS section 8
    // makes confirming medical registration before listing the client's
    // obligation, and a platform that let a psychiatrist through with the
    // column empty would be quietly working against it.
    const registrationNumberRequired = await this.specialties.requiresRegistrationNumber(
      doctor.specialtyId,
    );
    const registrationNumberMissing =
      registrationNumberRequired && !doctor.registrationNumber?.trim();

    return {
      doctorId,
      status: doctor.verificationStatus,
      rejectionReason: doctor.rejectionReason,
      required,
      approved,
      outstanding,
      rejected: outstanding.filter((type) => rejectedTypes.has(type)),
      registrationNumberRequired,
      registrationNumberMissing,
      readyForVerification: outstanding.length === 0 && !registrationNumberMissing,
      documents: documents.map(toSummary),
    };
  }

  /** The admin approval queue: every credential still waiting on a decision. */
  async pendingReviewQueue(
    limit = 50,
  ): Promise<(CredentialSummary & { doctorId: string; doctorName: string })[]> {
    const documents = await this.prisma.doctorDocument.findMany({
      where: { reviewStatus: DocumentReviewStatus.pending },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit, 200),
      include: { doctor: { select: { fullName: true } } },
    });
    return documents.map((document) => ({
      ...toSummary(document),
      doctorId: document.doctorId,
      doctorName: document.doctor.fullName,
    }));
  }

  /**
   * A short-lived signed URL for one credential. Only that doctor and an admin
   * can ask, and the answer expires in minutes - `storage_key` itself is never
   * returned to anyone, so a credential has no address that can be shared on.
   *
   * Every read is an audit entry. These are somebody's identity documents.
   */
  async downloadUrl(documentId: string, actor: AuthenticatedActor): Promise<SignedUrl> {
    const document = await this.prisma.doctorDocument.findUnique({ where: { id: documentId } });
    if (!document) throw documentNotFound();
    if (actor.type === 'doctor' && actor.id !== document.doctorId) {
      // Not a 403: to this doctor, another doctor's credential does not exist.
      throw documentNotFound();
    }
    if (actor.type === 'patient') {
      throw new AppException(
        PlatformError.FORBIDDEN,
        'You do not have access to this document.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'read',
      entityType: 'doctor_document',
      entityId: documentId,
      metadata: { documentType: document.documentType, doctorId: document.doctorId },
    });
    return this.storage.signDownload(document.storageKey, document.fileName);
  }

  // -- Review ---------------------------------------------------------------

  /**
   * Approves or rejects ONE credential. Each document is signed off on its own
   * (MODULES M-05), so a doctor whose degree is fine but whose address proof is
   * illegible is told exactly that and re-uploads only the one.
   *
   * A decision is final. Changing an approval into a rejection after the fact
   * would rewrite the record of what was approved and when; the doctor uploads
   * a fresh document instead, and the old row stays as history.
   */
  async reviewDocument(
    documentId: string,
    decision: { approved: boolean; rejectionReason?: string },
    actor: AuthenticatedActor,
  ): Promise<CredentialSummary> {
    const document = await this.prisma.doctorDocument.findUnique({ where: { id: documentId } });
    if (!document) throw documentNotFound();
    if (document.reviewStatus !== DocumentReviewStatus.pending) {
      throw new AppException(
        DoctorsError.DOCUMENT_ALREADY_REVIEWED,
        'This document has already been reviewed. Ask the doctor to upload a replacement.',
        HttpStatus.CONFLICT,
      );
    }
    if (!decision.approved && !decision.rejectionReason?.trim()) {
      // Also a CHECK on the table. A rejection with no reason is an
      // unanswerable support ticket for the doctor who receives it.
      throw new AppException(
        PlatformError.VALIDATION_FAILED,
        'Say why the document was rejected - the doctor has to act on it.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.doctorDocument.update({
      where: { id: documentId },
      data: {
        reviewStatus: decision.approved
          ? DocumentReviewStatus.approved
          : DocumentReviewStatus.rejected,
        verifiedByAdminId: actor.id,
        verifiedAt: new Date(),
        rejectionReason: decision.approved ? null : decision.rejectionReason!.trim(),
      },
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'verify',
      entityType: 'doctor_document',
      entityId: documentId,
      metadata: {
        doctorId: document.doctorId,
        documentType: document.documentType,
        decision: decision.approved ? 'approved' : 'rejected',
        ...(decision.approved ? {} : { reason: decision.rejectionReason }),
      },
    });

    if (!decision.approved) {
      await this.notifications.notify({
        code: 'document_rejected',
        to: { doctorId: document.doctorId },
        variables: { rejectionReason: decision.rejectionReason!.trim() },
      });
    }
    return toSummary(updated);
  }

  /**
   * Step 4: the admin signs the DOCTOR off. Refused while any credential their
   * specialty requires is missing or unapproved - which is the whole point of
   * approving them one at a time.
   *
   * This does not list the doctor. That is a separate, deliberate action.
   */
  async verifyDoctor(doctorId: string, actor: AuthenticatedActor): Promise<VerificationProgress> {
    const progress = await this.progressOf(doctorId);
    if (progress.registrationNumberMissing) {
      // Named separately from the document list: an admin told only "credentials
      // outstanding" would go looking through uploads for something that is not
      // there, when what is missing is a field on the profile.
      throw new AppException(
        DoctorsError.CREDENTIALS_INCOMPLETE,
        'This provider’s specialty uses the doctor registration form, so a medical council registration number is required before they can be verified (FR-19.7).',
        HttpStatus.CONFLICT,
        { registrationNumberRequired: true },
      );
    }
    if (!progress.readyForVerification) {
      throw new AppException(
        DoctorsError.CREDENTIALS_INCOMPLETE,
        'This doctor still has credentials outstanding.',
        HttpStatus.CONFLICT,
        { outstanding: progress.outstanding },
      );
    }

    await this.prisma.doctor.update({
      where: { id: doctorId },
      data: {
        verificationStatus: DoctorVerificationStatus.verified,
        verifiedByAdminId: actor.id,
        verifiedAt: new Date(),
        rejectionReason: null,
      },
    });

    // The admin's note on the doctor decision itself is the metadata of this
    // entry, which is why `doctors` carries no `verification_note`.
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'verify',
      entityType: 'doctor_verification',
      entityId: doctorId,
      metadata: { to: 'verified', approvedDocuments: progress.approved },
    });
    this.events.publish('doctor.verified', { doctorId, verifiedByAdminId: actor.id });
    await this.notifications.notify({ code: 'doctor_approved', to: { doctorId } });

    return this.progressOf(doctorId);
  }

  /**
   * Turns the application down. The doctor keeps their row and their uploads -
   * an admin can put them back to `pending` by asking for new documents.
   *
   * The reason is kept on the row AND sent to them: a rejected doctor can sign
   * in to read it, correct their details and resubmit (their next registration
   * save moves them back to `under_review`).
   */
  async rejectDoctor(
    doctorId: string,
    reason: string,
    actor: AuthenticatedActor,
  ): Promise<VerificationProgress> {
    await this.requireDoctor(doctorId);
    await this.prisma.doctor.update({
      where: { id: doctorId },
      data: {
        verificationStatus: DoctorVerificationStatus.rejected,
        isListed: false,
        rejectionReason: reason,
      },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'verify',
      entityType: 'doctor_verification',
      entityId: doctorId,
      metadata: { to: 'rejected', reason },
    });
    await this.notifications.notify({
      code: 'doctor_rejected',
      to: { doctorId },
      variables: { rejectionReason: reason },
    });
    return this.progressOf(doctorId);
  }

  /**
   * Reopens a rejected application so the doctor can sign in and replace what
   * was turned down. Approvals already given are kept: they were decisions
   * about documents, and those documents have not changed.
   */
  async reopen(doctorId: string, actor: AuthenticatedActor): Promise<VerificationProgress> {
    const doctor = await this.requireDoctor(doctorId);
    if (doctor.verificationStatus !== DoctorVerificationStatus.rejected) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_APPROVED,
        'Only a rejected application can be reopened.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { verificationStatus: DoctorVerificationStatus.under_review, rejectionReason: null },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'verify',
      entityType: 'doctor_verification',
      entityId: doctorId,
      metadata: { from: 'rejected', to: 'under_review' },
    });
    return this.progressOf(doctorId);
  }

  private async requireDoctor(doctorId: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: {
        id: true,
        specialtyId: true,
        verificationStatus: true,
        registrationNumber: true,
        rejectionReason: true,
      },
    });
    if (!doctor) {
      throw new AppException(
        DoctorsError.DOCTOR_NOT_FOUND,
        'That doctor does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return doctor;
  }
}

/** `storage_key` is deliberately absent: it is never returned to a client. */
function toSummary(document: DoctorDocument): CredentialSummary {
  return {
    id: document.id,
    documentType: document.documentType,
    fileName: document.fileName,
    reviewStatus: document.reviewStatus,
    rejectionReason: document.rejectionReason,
    verifiedByAdminId: document.verifiedByAdminId,
    verifiedAt: document.verifiedAt,
    uploadedAt: document.createdAt,
  };
}

function documentNotFound(): AppException {
  return new AppException(
    DoctorsError.DOCUMENT_NOT_FOUND,
    'That document does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

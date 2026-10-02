import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PatientFile, PatientFileCategory, ReportRequestStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SignedUrl } from '../storage/object-storage';
import { CONSULTATION_ACCESS, ConsultationAccess } from './consultation-access';
import { FilesError } from './files.errors';
import {
  PATIENT_FILE_STORAGE,
  PatientFileStorage,
  keyBelongsToPatient,
  patientFileKey,
} from './patient-file-storage';

/** What a client may send. A prescription PDF is generated, never uploaded. */
export const UPLOADABLE_CATEGORIES = [
  PatientFileCategory.medical_history,
  PatientFileCategory.report,
  PatientFileCategory.photo,
] as const;

export type UploadableCategory = (typeof UPLOADABLE_CATEGORIES)[number];

export interface UploadRequest {
  category: UploadableCategory;
  fileName: string;
  contentType: string;
}

export interface ConfirmUpload {
  category: UploadableCategory;
  fileName: string;
  storageKey: string;
  /** Attaches the file to one booking (FR-6.3). Absent = held against the patient. */
  consultationId?: string;
  /** Answers a doctor's request, so the file arrives labelled (FR-4.9). */
  reportRequestId?: string;
}

export interface ConfirmDoctorUpload {
  category: UploadableCategory;
  fileName: string;
  storageKey: string;
  /** Required: a doctor's upload is always anchored to a consultation they treat. */
  consultationId: string;
}

/** What a client sees. Never the storage key. */
export interface PatientFileRecord {
  id: string;
  category: PatientFileCategory;
  fileName: string;
  consultationId: string | null;
  reportRequestId: string | null;
  /** Null when the patient uploaded it themselves. */
  uploadedByDoctorId: string | null;
  createdAt: Date;
}

export interface FileListFilter {
  category?: PatientFileCategory;
  consultationId?: string;
}

/**
 * M-10's centre: the patient's clinical files, and who may open one.
 *
 * *** THE ACCESS RULE IS THE MODULE. *** Done when "no file opens for anyone
 * outside that patient's own care", so every read - list, download, delete -
 * goes through one gate rather than each endpoint remembering to check. The
 * gate has exactly three ways through:
 *
 *   1. the patient, for their own files;
 *   2. a doctor who has consulted that patient, through
 *      `ConsultationAccess.isTreating` - which also gives them the history that
 *      predates their own booking, as MODULES M-10 requires;
 *   3. nobody else. An admin is NOT on this list: SRS 6.2 gives an admin the
 *      panel, not the clinical record, and `assertOwnership`'s
 *      `adminMayAccess` is deliberately not used anywhere in this file.
 */
@Injectable()
export class PatientFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(PATIENT_FILE_STORAGE) private readonly storage: PatientFileStorage,
    @Inject(CONSULTATION_ACCESS) private readonly consultations: ConsultationAccess,
  ) {}

  // -- Upload ---------------------------------------------------------------

  /**
   * Step 1 of two: a URL the client PUTs the bytes to. No row is written yet.
   *
   * The key is minted here from the patient's own id, so a client cannot name
   * where its file lands, and step 2 will only accept a key that came from
   * this call for this patient.
   */
  async requestUpload(
    patientId: string,
    input: UploadRequest,
  ): Promise<{ storageKey: string; upload: SignedUrl }> {
    assertUploadable(input.category);
    const storageKey = patientFileKey(patientId, input.category, input.fileName);
    const upload = await this.storage.signUpload(storageKey, input.contentType);
    return { storageKey, upload };
  }

  /**
   * Step 2: the bytes are in the store, so the row is written.
   *
   * A row and an object can only disagree in one direction here. If the client
   * never confirms, an object is orphaned and M-21's retention job sweeps it;
   * the reverse - a row pointing at nothing - cannot happen, because the row is
   * written last.
   */
  async confirmUpload(patientId: string, input: ConfirmUpload): Promise<PatientFileRecord> {
    assertUploadable(input.category);
    if (!keyBelongsToPatient(input.storageKey, patientId)) {
      // Not a 403: to this patient, a key they were never issued does not exist.
      throw new AppException(
        FilesError.UPLOAD_NOT_RECOGNISED,
        'That upload was not recognised. Ask for a fresh upload URL and try again.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Medical history belongs to the PATIENT, not to one booking (MODULES
    // M-10). A CHECK enforces the same rule, because history pinned to a
    // consultation would be invisible at the next one.
    const consultationId =
      input.category === PatientFileCategory.medical_history ? undefined : input.consultationId;

    const request = input.reportRequestId
      ? await this.requireOpenRequestFor(patientId, input.reportRequestId)
      : null;
    if (request && !consultationId) {
      // The file must belong to the booking the request was raised in, or the
      // doctor who asked would never see it. A CHECK says the same.
      throw new AppException(
        FilesError.CONSULTATION_NOT_FOUND,
        'A file answering a request must be attached to that consultation.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (consultationId) await this.assertConsultationIsTheirs(patientId, consultationId);

    const created = await this.prisma.$transaction(async (tx) => {
      const file = await tx.patientFile.create({
        data: {
          patientId,
          fileCategory: input.category,
          fileName: input.fileName,
          storageKey: input.storageKey,
          consultationId: consultationId ?? null,
          reportRequestId: request?.id ?? null,
        },
      });
      // *** THE REQUEST IS FULFILLED BY THE FILE ARRIVING. *** There is no
      // `fulfilled_at` on the request: this row's `created_at` is that time,
      // and one timestamp cannot disagree with itself.
      if (request) {
        await tx.reportRequest.update({
          where: { id: request.id },
          data: { status: ReportRequestStatus.fulfilled },
        });
      }
      return file;
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: 'patient_file',
      entityId: created.id,
      consultationId: created.consultationId,
      // The file NAME is not recorded: "hiv-result.pdf" in an audit metadata
      // blob is the clinical detail the trail exists to protect.
      metadata: { category: created.fileCategory, answeredRequest: Boolean(request) },
    });

    if (request && created.consultationId) {
      const consultation = await this.consultations.contextOf(created.consultationId);
      if (consultation?.doctorId) {
        const patient = await this.prisma.patient.findUnique({
          where: { id: patientId },
          select: { fullName: true },
        });
        await this.notifications.notify({
          code: 'report_uploaded',
          to: { doctorId: consultation.doctorId },
          consultationId: created.consultationId,
          variables: { patientName: patient?.fullName ?? 'A patient' },
          deepLink: { screen: 'consultation', consultationId: created.consultationId },
        });
      }
    }
    return shape(created);
  }

  /**
   * Step 1 for a doctor uploading on a patient's behalf (e.g. a paper report
   * handed over at a visit). Same signed-URL handshake as the patient's own
   * upload, but `patientId` is attacker-controlled here (it comes off the
   * URL, not the caller's own id), so treatment is checked before a URL is
   * ever minted — unlike `requestUpload`, which is safe by construction
   * because a patient can only ever request one for themselves.
   */
  async requestDoctorUpload(
    doctorId: string,
    patientId: string,
    input: UploadRequest,
  ): Promise<{ storageKey: string; upload: SignedUrl }> {
    await this.assertTreating(doctorId, patientId);
    return this.requestUpload(patientId, input);
  }

  /**
   * Step 2 for a doctor's upload. Always anchored to a consultation the
   * doctor is treating — not just one of the patient's bookings with anybody
   * — so a clinician cannot write into a record they only ever read.
   */
  async confirmDoctorUpload(
    doctorId: string,
    patientId: string,
    input: ConfirmDoctorUpload,
  ): Promise<PatientFileRecord> {
    await this.assertTreating(doctorId, patientId);
    assertUploadable(input.category);
    if (!keyBelongsToPatient(input.storageKey, patientId)) {
      throw new AppException(
        FilesError.UPLOAD_NOT_RECOGNISED,
        'That upload was not recognised. Ask for a fresh upload URL and try again.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const consultation = await this.consultations.contextOf(input.consultationId);
    if (!consultation || consultation.patientId !== patientId || consultation.doctorId !== doctorId) {
      throw new AppException(
        FilesError.CONSULTATION_NOT_FOUND,
        'That consultation does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Medical history belongs to the PATIENT, not to one booking — the same
    // rule `confirmUpload` applies to the patient's own uploads.
    const consultationId =
      input.category === PatientFileCategory.medical_history ? undefined : input.consultationId;

    const created = await this.prisma.patientFile.create({
      data: {
        patientId,
        fileCategory: input.category,
        fileName: input.fileName,
        storageKey: input.storageKey,
        consultationId: consultationId ?? null,
        uploadedByDoctorId: doctorId,
      },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'create',
      entityType: 'patient_file',
      entityId: created.id,
      consultationId: created.consultationId,
      metadata: { category: created.fileCategory },
    });

    return shape(created);
  }

  /**
   * A file the PLATFORM generated - a prescription or therapy-plan PDF.
   *
   * No endpoint, on purpose: nobody uploads one of these. M-15 calls this when
   * it renders the record a doctor has just finalised, which is why the
   * capability was written before its caller existed.
   */
  async storeGeneratedPdf(input: {
    patientId: string;
    consultationId: string;
    doctorId: string;
    fileName: string;
    storageKey: string;
  }): Promise<PatientFileRecord> {
    const created = await this.prisma.patientFile.create({
      data: {
        patientId: input.patientId,
        fileCategory: PatientFileCategory.prescription_pdf,
        fileName: input.fileName,
        storageKey: input.storageKey,
        consultationId: input.consultationId,
        uploadedByDoctorId: input.doctorId,
      },
    });
    return shape(created);
  }

  // -- Read -----------------------------------------------------------------

  /**
   * A patient's files, for the patient or for a doctor treating them.
   *
   * The whole history is returned, including files uploaded before this
   * doctor's first consultation with them - which is the point of holding
   * medical history against the patient rather than a booking.
   */
  async listFor(
    patientId: string,
    actor: AuthenticatedActor,
    filter: FileListFilter = {},
  ): Promise<PatientFileRecord[]> {
    await this.assertMayReach(patientId, actor);
    const rows = await this.prisma.patientFile.findMany({
      where: {
        patientId,
        deletedAt: null,
        ...(filter.category ? { fileCategory: filter.category } : {}),
        ...(filter.consultationId ? { consultationId: filter.consultationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(shape);
  }

  /**
   * A short-lived signed URL for one file (SRS 6.1: links are not publicly
   * guessable). `storage_key` itself is never returned, so a file has no address
   * that can be shared onward - and the signature expires in minutes.
   *
   * Every read is an audit entry. These are somebody's clinical records.
   */
  async downloadUrl(
    fileId: string,
    actor: AuthenticatedActor,
  ): Promise<SignedUrl & { sizeBytes: number | null }> {
    const file = await this.requireReachable(fileId, actor);

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'read',
      entityType: 'patient_file',
      entityId: fileId,
      consultationId: file.consultationId,
      metadata: { category: file.fileCategory, patientId: file.patientId },
    });
    const [signed, stat] = await Promise.all([
      this.storage.signDownload(file.storageKey, file.fileName),
      this.storage.stat(file.storageKey),
    ]);
    return { ...signed, sizeBytes: stat?.sizeBytes ?? null };
  }

  // -- Delete ---------------------------------------------------------------

  /**
   * The patient removes their own upload (MODULES M-10) - unless a completed
   * consultation relied on it.
   *
   * A soft delete: `deleted_at` is set and every read stops returning it, but
   * the stored object is left for M-21's retention job. Erasing bytes here
   * would put the DPDP deletion path in two places, and M-03 already owns the
   * request while M-21 owns the execution and its evidence.
   */
  async deleteOwnFile(fileId: string, patientId: string): Promise<void> {
    const file = await this.prisma.patientFile.findFirst({
      where: { id: fileId, patientId, deletedAt: null },
    });
    if (!file) throw fileNotFound();

    // A doctor's upload is not the patient's to remove, even from their own
    // record: it is the clinician's entry about them.
    if (file.uploadedByDoctorId) throw partOfARecord();

    if (file.consultationId) {
      const consultation = await this.consultations.contextOf(file.consultationId);
      // Unresolvable is treated as "keep". A file attached to a booking this
      // module cannot read about is not one to delete on a guess.
      if (!consultation || consultation.isCompleted) throw partOfARecord();
    }

    await this.prisma.patientFile.update({
      where: { id: fileId },
      data: { deletedAt: new Date() },
    });
    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'delete',
      entityType: 'patient_file',
      entityId: fileId,
      consultationId: file.consultationId,
      metadata: { category: file.fileCategory },
    });
  }

  // -- The gate -------------------------------------------------------------

  /**
   * *** THE ONE ACCESS CHECK. *** Everything above calls this, so there is one
   * place to read, one place to get right, and one place to change when M-11
   * makes `isTreating` mean something.
   */
  async assertMayReach(patientId: string, actor: AuthenticatedActor): Promise<void> {
    if (actor.type === 'patient') {
      if (actor.id === patientId) return;
      throw fileNotFound();
    }
    if (actor.type === 'doctor' && (await this.consultations.isTreating(actor.id, patientId))) {
      return;
    }
    // An admin lands here too. SRS 6.2 gives them the panel, not the clinical
    // record; a support question about a file is answered from the audit trail,
    // which records every read without exposing one.
    throw fileNotFound();
  }

  private async requireReachable(fileId: string, actor: AuthenticatedActor): Promise<PatientFile> {
    const file = await this.prisma.patientFile.findFirst({
      where: { id: fileId, deletedAt: null },
    });
    // A de-identified clarification attachment has no patient and is reached
    // through M-12's case, never through here.
    if (!file?.patientId) throw fileNotFound();
    await this.assertMayReach(file.patientId, actor);
    return file;
  }

  /** Same "not found" answer as `assertMayReach`'s doctor branch — see its note on why. */
  private async assertTreating(doctorId: string, patientId: string): Promise<void> {
    if (!(await this.consultations.isTreating(doctorId, patientId))) throw fileNotFound();
  }

  private async assertConsultationIsTheirs(
    patientId: string,
    consultationId: string,
  ): Promise<void> {
    const consultation = await this.consultations.contextOf(consultationId);
    if (!consultation || consultation.patientId !== patientId) {
      throw new AppException(
        FilesError.CONSULTATION_NOT_FOUND,
        'That consultation does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async requireOpenRequestFor(patientId: string, requestId: string) {
    const request = await this.prisma.reportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw requestNotFound();

    const consultation = await this.consultations.contextOf(request.consultationId);
    if (!consultation || consultation.patientId !== patientId) throw requestNotFound();
    if (request.status !== ReportRequestStatus.open) {
      throw new AppException(
        FilesError.REPORT_REQUEST_CLOSED,
        'That request is no longer open.',
        HttpStatus.CONFLICT,
      );
    }
    return request;
  }
}

function assertUploadable(category: PatientFileCategory): void {
  if (!(UPLOADABLE_CATEGORIES as readonly PatientFileCategory[]).includes(category)) {
    throw new AppException(
      FilesError.CATEGORY_NOT_UPLOADABLE,
      'A prescription PDF is generated by the platform, and a clarification attachment is created by your doctor. Neither is uploaded.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * The same answer for "no such file" and "not yours". A distinct 403 would
 * confirm that a file exists for a patient the caller may not read about, which
 * is itself the disclosure SRS 6.2 is guarding.
 */
function fileNotFound(): AppException {
  return new AppException(
    FilesError.FILE_NOT_FOUND,
    'That file does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

function requestNotFound(): AppException {
  return new AppException(
    FilesError.REPORT_REQUEST_NOT_FOUND,
    'That request does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

function partOfARecord(): AppException {
  return new AppException(
    FilesError.FILE_IS_PART_OF_A_RECORD,
    'This file is part of a completed consultation and cannot be removed. Ask support if you need it taken down.',
    HttpStatus.CONFLICT,
  );
}

function shape(file: PatientFile): PatientFileRecord {
  return {
    id: file.id,
    category: file.fileCategory,
    fileName: file.fileName,
    consultationId: file.consultationId,
    reportRequestId: file.reportRequestId,
    uploadedByDoctorId: file.uploadedByDoctorId,
    createdAt: file.createdAt,
  };
}

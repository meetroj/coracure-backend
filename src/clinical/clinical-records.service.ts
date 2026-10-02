import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ClinicalRecord,
  Consultation,
  ConsultationStatus,
  PatientFileCategory,
  Prisma,
  RiskCategory,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { SPECIALTY_CATALOGUE, SpecialtyCatalogue } from '../doctors/specialty-catalogue';
import { CONTENT_LIBRARY, ContentLibrary } from './content-library';
import {
  PATIENT_FILE_STORAGE,
  PatientFileStorage,
  patientFileKey,
} from '../files/patient-file-storage';
import { PatientFilesService } from '../files/patient-files.service';
import { PresenceService } from '../instant/presence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ageFrom } from '../patients/date-of-birth';
import { ClinicalError } from './clinical.errors';
import { Medicine, Outstanding, outstandingFor } from './completion';
import { SaveClinicalRecordDto } from './dto/clinical.dto';
import { renderPrescriptionPdf } from './prescription-pdf';

/** The full record, as the treating doctor and an admin see it. */
export interface ClinicalRecordView {
  consultationId: string;
  chiefComplaint: string;
  clinicalHistory: string | null;
  diagnosis: string | null;
  isDiagnosisProvisional: boolean;
  riskCategory: RiskCategory;
  referralNote: string | null;
  /**
   * FR-11.1's "whether a referral was advised", derived rather than stored -
   * a separate flag beside `referralNote` could disagree with it. Not
   * reopening that design decision, just answering the question from it.
   */
  referralAdvised: boolean;
  medicines: Medicine[];
  advice: {
    covered: string | null;
    homePractice: string | null;
    nextFocus: string | null;
    warningSigns: string | null;
  };
  caseSummary: string | null;
  recommendedContentIds: string[];
  /** Null = still a draft. There is no status field beside it. */
  finalisedAt: Date | null;
  /** Whether this professional may prescribe, so the app shows the right form. */
  canPrescribe: boolean;
  /** Empty once the record can be finalised (FR-11.5). */
  outstanding: Outstanding[];
  updatedAt: Date;
}

/**
 * What the PATIENT is given: the treatment, not the clinical reasoning.
 *
 * This is deliberately narrower than the doctor's view and matches what the
 * prescription PDF prints. `clinicalHistory`, `caseSummary` and `riskCategory`
 * are professional record - the case summary is a handover written for the next
 * clinician, and a risk category is a triage decision that means something
 * quite different read by the person it is about. The patient gets the
 * diagnosis, what to take, what to do, and when to worry.
 */
export interface PatientCareView {
  consultationId: string;
  diagnosis: string | null;
  isDiagnosisProvisional: boolean;
  medicines: Medicine[];
  advice: {
    covered: string | null;
    homePractice: string | null;
    nextFocus: string | null;
    warningSigns: string | null;
  };
  referralNote: string | null;
  recommendedContentIds: string[];
  issuedAt: Date;
}

/** One line of FR-9.3's pending-documentation worklist. */
export interface PendingDocumentation {
  consultationId: string;
  referenceCode: string;
  scheduledStartAt: Date | null;
  status: ConsultationStatus;
  /** Null when the doctor has not opened the record yet. */
  startedAt: Date | null;
  outstanding: Outstanding[];
}

/** The call has happened, or is happening. Anything else has nothing to write up. */
const DOCUMENTABLE: ConsultationStatus[] = [
  // A doctor writes notes DURING the consultation as often as after it.
  ConsultationStatus.in_progress,
  // The call is over and this is the only thing left to do.
  ConsultationStatus.awaiting_documentation,
];

/**
 * M-15 Clinical Records. Owns `clinical_records`, one row per consultation.
 *
 * *** THE RECORD FREEZES. *** `finalised_at` is the moment it stops being a
 * draft and becomes evidence: a prescription the patient holds a PDF of, and
 * the handover the next clinician reads. Nothing edits it afterwards, and there
 * is no method here that does - that absence is the requirement.
 *
 * *** TWO PROFESSIONS, ONE RECORD. *** A psychiatrist closes with a
 * prescription or with advice; a psychologist closes with the advice and
 * therapy plan, and cannot save a medicine at all. Both write the SAME row and
 * both produce the same patient PDF, because a patient should not be able to
 * tell from the shape of their record which kind of professional they saw.
 */
@Injectable()
export class ClinicalRecordsService {
  private readonly logger = new Logger(ClinicalRecordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly presence: PresenceService,
    private readonly notifications: NotificationsService,
    private readonly files: PatientFilesService,
    @Inject(SPECIALTY_CATALOGUE) private readonly catalogue: SpecialtyCatalogue,
    @Inject(CONTENT_LIBRARY) private readonly content: ContentLibrary,
    @Inject(PATIENT_FILE_STORAGE) private readonly storage: PatientFileStorage,
  ) {}

  /**
   * *** FR-15.4. *** The doctor's Care Hub picks, checked against the library.
   *
   * Unchecked ids were a real gap while M-18 did not exist: a typo, or an item
   * archived since, put a broken link on the Care Plan of a patient who had
   * been told to read it - and nobody would find out until they tapped it.
   *
   * M-18 answers through the `CONTENT_LIBRARY` port. Its closed default calls
   * everything unrecommendable, so a deployment without the library refuses to
   * store picks nothing can verify rather than storing them hopefully.
   */
  private async checkedContentIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rejected = await this.content.unrecommendable(ids);
    if (rejected.length > 0) {
      throw new AppException(
        ClinicalError.CONTENT_NOT_RECOMMENDABLE,
        'Some of the recommended items are not published and cannot be shared with the patient.',
        HttpStatus.BAD_REQUEST,
        // WHICH ones, so the doctor can drop the offender rather than losing
        // the whole selection.
        { rejected },
      );
    }
    return ids;
  }

  // -- Writing --------------------------------------------------------------

  /**
   * Save the record, or update it. Called as often as the doctor likes while
   * the case is open.
   *
   * An upsert rather than separate create and update calls: the doctor's app
   * autosaves a form, and asking it to know whether a row exists yet would make
   * the first save a different request from the second for no benefit.
   */
  async save(
    consultationId: string,
    input: SaveClinicalRecordDto,
    actor: AuthenticatedActor,
  ): Promise<ClinicalRecordView> {
    const { canPrescribe } = await this.requireWritable(consultationId, actor);
    const medicines = normaliseMedicines(input.medicines);

    // *** FR-4.3, THE SCOPE-OF-PRACTICE RULE. *** Checked before anything is
    // written, so a refused save leaves the record exactly as it was.
    if (medicines.length > 0 && !canPrescribe) {
      throw new AppException(
        ClinicalError.PRESCRIBING_NOT_PERMITTED,
        'Your specialty does not permit prescribing medicines. Record the advice and therapy plan instead — that is the closing record for your specialty.',
        HttpStatus.FORBIDDEN,
      );
    }

    const data = {
      chiefComplaint: input.chiefComplaint.trim(),
      riskCategory: input.riskCategory,
      clinicalHistory: trimmed(input.clinicalHistory),
      diagnosis: trimmed(input.diagnosis),
      isDiagnosisProvisional: input.isDiagnosisProvisional ?? true,
      referralNote: trimmed(input.referralNote),
      medicines: medicines as unknown as Prisma.InputJsonValue,
      adviceCovered: trimmed(input.adviceCovered),
      adviceHomePractice: trimmed(input.adviceHomePractice),
      adviceNextFocus: trimmed(input.adviceNextFocus),
      adviceWarningSigns: trimmed(input.adviceWarningSigns),
      caseSummary: trimmed(input.caseSummary),
      recommendedContentIds: (await this.checkedContentIds(
        input.recommendedContentIds ?? [],
      )) as unknown as Prisma.InputJsonValue,
    };

    const saved = await this.prisma.clinicalRecord.upsert({
      where: { consultationId },
      create: { consultationId, ...data },
      update: data,
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'clinical_record',
      entityId: saved.id,
      consultationId,
      // The clinical CONTENT is not copied into the trail: it is already stored
      // once, and an audit log holding a second copy of a patient's diagnosis
      // is a second thing to protect and to erase under SRS 6.4.
      metadata: {
        draft: saved.finalisedAt === null,
        medicineCount: medicines.length,
        riskCategory: saved.riskCategory,
      },
    });

    return this.view(saved, canPrescribe);
  }

  /**
   * *** FR-11.5. THE CASE CLOSES HERE. ***
   *
   * Three things happen together and must not come apart: the record freezes,
   * the consultation completes, and M-13's instant-consult gate opens. A
   * completed consultation whose record is still a draft would be a case closed
   * with nothing written in it; a frozen record on a consultation still marked
   * in progress would leave the doctor blocked from their next patient for ever.
   *
   * The database holds the same completion rule as a CHECK. This method decides
   * WHICH closing record is owed - which needs the specialty, and no constraint
   * can see it - and refuses with a list a doctor can act on rather than a
   * constraint violation.
   */
  async finalise(consultationId: string, actor: AuthenticatedActor): Promise<ClinicalRecordView> {
    const { consultation, canPrescribe } = await this.requireWritable(consultationId, actor);
    const record = await this.requireRecord(consultationId);

    const outstanding = outstandingFor({ ...record, medicines: medicinesOf(record) }, canPrescribe);
    if (outstanding.length > 0) {
      throw new AppException(
        ClinicalError.RECORD_INCOMPLETE,
        'This case cannot be completed yet.',
        HttpStatus.CONFLICT,
        { outstanding },
      );
    }

    const finalisedAt = new Date();
    const [finalised] = await this.prisma.$transaction([
      this.prisma.clinicalRecord.update({
        where: { consultationId },
        data: { finalisedAt },
      }),
      // M-11 owns the status; this is the one transition M-15 causes, and it
      // rides the same transaction because the two facts are one event.
      this.prisma.consultation.update({
        where: { id: consultationId },
        data: { status: ConsultationStatus.completed },
      }),
    ]);

    // FR-10.5: the completion gate. Outside the transaction because it is
    // another module's row and a failure to open it must not roll back a
    // finalised clinical record - the case IS documented either way, and a gate
    // that stays shut is a support call rather than a lost record.
    if (consultation.doctorId) {
      try {
        await this.presence.clearCompletionGate(consultation.doctorId);
      } catch (error) {
        this.logger.error(
          { err: error, consultationId, doctorId: consultation.doctorId },
          'Finalised the record but could not open the instant-consult gate',
        );
      }
    }

    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'clinical_record',
      entityId: finalised.id,
      consultationId,
      metadata: { finalised: true, medicineCount: medicinesOf(finalised).length },
    });

    await this.notifications.notify({
      code: 'prescription_ready',
      to: { patientId: consultation.patientId },
      consultationId,
      variables: { doctorName: await this.doctorNameOf(consultation.doctorId) },
      deepLink: { screen: 'consultation', consultationId },
    });

    // FR-9.5's PDF. Outside the transaction and never allowed to undo the
    // finalised record: the record IS the evidence either way, and a
    // rendering failure is a support call, not a reason to un-finalise a
    // consultation a doctor has already closed.
    try {
      await this.generatePrescriptionPdf(consultation, finalised);
    } catch (error) {
      this.logger.error(
        { err: error, consultationId },
        'Finalised the record but could not render the PDF',
      );
    }

    return this.view(finalised, canPrescribe);
  }

  // -- Reading --------------------------------------------------------------

  /** The full record, for the treating doctor. */
  async forDoctor(consultationId: string, actor: AuthenticatedActor): Promise<ClinicalRecordView> {
    const consultation = await this.requireConsultation(consultationId);
    if (consultation.doctorId !== actor.id) throw notFound();
    const record = await this.requireRecord(consultationId);
    return this.view(record, await this.mayPrescribe(consultation.doctorId));
  }

  /**
   * What the patient is given, once it has been issued.
   *
   * A draft is not shown at all. Until the doctor finalises, there is nothing
   * to act on and half a prescription is worse than none.
   */
  async forPatient(consultationId: string, actor: AuthenticatedActor): Promise<PatientCareView> {
    const consultation = await this.requireConsultation(consultationId);
    if (consultation.patientId !== actor.id) throw notFound();

    const record = await this.requireRecord(consultationId);
    if (!record.finalisedAt) {
      throw new AppException(
        ClinicalError.RECORD_NOT_FOUND,
        'Your doctor has not issued this record yet.',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      consultationId,
      diagnosis: record.diagnosis,
      isDiagnosisProvisional: record.isDiagnosisProvisional,
      medicines: medicinesOf(record),
      advice: adviceOf(record),
      referralNote: record.referralNote,
      recommendedContentIds: contentIdsOf(record),
      issuedAt: record.finalisedAt,
    };
  }

  /**
   * The record, for clinical governance.
   *
   * A read, never a write: an admin cannot author or alter a clinical record,
   * because the professional who saw the patient is the one accountable for
   * what it says.
   */
  async forAdmin(consultationId: string, actor: AuthenticatedActor): Promise<ClinicalRecordView> {
    assertPermission(actor, 'clinical_governance', 'operations');
    const consultation = await this.requireConsultation(consultationId);
    const record = await this.requireRecord(consultationId);
    return this.view(record, await this.mayPrescribe(consultation.doctorId));
  }

  /**
   * FR-9.3's pending clinical tasks: every consultation this doctor has held
   * and not yet written up, with what each one still needs.
   *
   * A consultation with NO record at all belongs here too - it is the most
   * outstanding case there is - which is why this walks consultations and left
   * joins the record rather than the other way round.
   */
  async pendingFor(doctorId: string): Promise<PendingDocumentation[]> {
    const canPrescribe = await this.mayPrescribe(doctorId);
    const rows = await this.prisma.consultation.findMany({
      where: {
        doctorId,
        status: { in: DOCUMENTABLE },
        // A record exists but is unfinalised, or there is no record yet.
        OR: [{ clinicalRecord: { is: null } }, { clinicalRecord: { finalisedAt: null } }],
      },
      orderBy: [{ scheduledStartAt: 'asc' }, { createdAt: 'asc' }],
      take: 100,
      include: { clinicalRecord: true },
    });

    return rows.map((row) => ({
      consultationId: row.id,
      referenceCode: row.referenceCode,
      scheduledStartAt: row.scheduledStartAt,
      status: row.status,
      startedAt: row.clinicalRecord?.createdAt ?? null,
      outstanding: row.clinicalRecord
        ? outstandingFor(
            { ...row.clinicalRecord, medicines: medicinesOf(row.clinicalRecord) },
            canPrescribe,
          )
        : outstandingFor({ medicines: [] }, canPrescribe),
    }));
  }

  // -- Internals ------------------------------------------------------------

  private async requireConsultation(consultationId: string): Promise<Consultation> {
    const found = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!found) throw notFound();
    return found;
  }

  /**
   * The treating doctor, on a consultation that has actually been held, whose
   * record is not already frozen.
   */
  private async requireWritable(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<{ consultation: Consultation; canPrescribe: boolean }> {
    const consultation = await this.requireConsultation(consultationId);
    // To anyone but the treating professional it does not exist. Not even to an
    // admin: `forAdmin` reads, and nobody else writes a clinical record.
    if (actor.type !== 'doctor' || consultation.doctorId !== actor.id) throw notFound();

    const existing = await this.prisma.clinicalRecord.findUnique({
      where: { consultationId },
      select: { finalisedAt: true },
    });
    if (existing?.finalisedAt) {
      throw new AppException(
        ClinicalError.RECORD_FINALISED,
        'This record was finalised and cannot be changed. Raise a new consultation if something needs correcting.',
        HttpStatus.CONFLICT,
        { finalisedAt: existing.finalisedAt },
      );
    }

    if (!DOCUMENTABLE.includes(consultation.status)) {
      throw new AppException(
        ClinicalError.NOT_DOCUMENTABLE,
        consultation.status === ConsultationStatus.completed
          ? 'This consultation is already complete.'
          : 'This consultation has not been held yet, so there is nothing to write up.',
        HttpStatus.CONFLICT,
        { status: consultation.status },
      );
    }

    return { consultation, canPrescribe: await this.mayPrescribe(consultation.doctorId) };
  }

  private async requireRecord(consultationId: string): Promise<ClinicalRecord> {
    const record = await this.prisma.clinicalRecord.findUnique({ where: { consultationId } });
    if (!record) {
      throw new AppException(
        ClinicalError.RECORD_NOT_FOUND,
        'No clinical record has been started for this consultation.',
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
  }

  /**
   * FR-4.3: prescribing is a property of the PROFESSIONAL'S specialty, not of
   * the service booked and not of the individual. M-06 owns the answer and M-05
   * declared the port; this only asks.
   *
   * A doctor with no specialty set gets `false`, which is the port's own
   * behaviour and the right way round: a rule that cannot be evaluated must
   * refuse rather than allow.
   */
  private async mayPrescribe(doctorId: string | null): Promise<boolean> {
    if (!doctorId) return false;
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { specialtyId: true },
    });
    return this.catalogue.canPrescribe(doctor?.specialtyId ?? null);
  }

  private view(record: ClinicalRecord, canPrescribe: boolean): ClinicalRecordView {
    const medicines = medicinesOf(record);
    return {
      consultationId: record.consultationId,
      chiefComplaint: record.chiefComplaint,
      clinicalHistory: record.clinicalHistory,
      diagnosis: record.diagnosis,
      isDiagnosisProvisional: record.isDiagnosisProvisional,
      riskCategory: record.riskCategory,
      referralNote: record.referralNote,
      referralAdvised: record.referralNote !== null,
      medicines,
      advice: adviceOf(record),
      caseSummary: record.caseSummary,
      recommendedContentIds: contentIdsOf(record),
      finalisedAt: record.finalisedAt,
      canPrescribe,
      // Always computed, never stored: what is outstanding changes with every
      // save, and a cached copy would be wrong the moment one happened.
      outstanding: outstandingFor({ ...record, medicines }, canPrescribe),
      updatedAt: record.updatedAt,
    };
  }

  private async doctorNameOf(doctorId: string | null): Promise<string> {
    if (!doctorId) return 'your provider';
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { fullName: true },
    });
    return doctor?.fullName ?? 'your provider';
  }

  /**
   * Renders the record just finalised to a PDF and stores it against the
   * patient - `storeGeneratedPdf`'s one caller, exactly as its own comment
   * always said M-15 would be.
   */
  private async generatePrescriptionPdf(
    consultation: Consultation,
    record: ClinicalRecord,
  ): Promise<void> {
    const [doctor, patient] = await Promise.all([
      consultation.doctorId
        ? this.prisma.doctor.findUnique({
            where: { id: consultation.doctorId },
            select: { fullName: true, qualification: true, registrationNumber: true },
          })
        : null,
      this.prisma.patient.findUnique({
        where: { id: consultation.patientId },
        select: { fullName: true, dateOfBirth: true, gender: true },
      }),
    ]);

    const bytes = await renderPrescriptionPdf({
      referenceCode: consultation.referenceCode,
      issuedAt: record.finalisedAt ?? new Date(),
      doctorName: doctor?.fullName ?? 'your provider',
      doctorQualification: doctor?.qualification ?? null,
      registrationNumber: doctor?.registrationNumber ?? null,
      // Sent to the patient it is about - unlike every doctor-facing screen,
      // there is no de-identification concern in this one document.
      patientName: patient?.fullName ?? 'Patient',
      patientAge: patient?.dateOfBirth ? ageFrom(patient.dateOfBirth) : null,
      patientGender: patient?.gender ?? 'undisclosed',
      diagnosis: record.diagnosis,
      isDiagnosisProvisional: record.isDiagnosisProvisional,
      medicines: medicinesOf(record),
      advice: adviceOf(record),
      referralNote: record.referralNote,
    });

    const fileName = `prescription-${consultation.referenceCode}.pdf`;
    const storageKey = patientFileKey(
      consultation.patientId,
      PatientFileCategory.prescription_pdf,
      fileName,
    );
    await this.storage.put(storageKey, bytes, 'application/pdf');
    await this.files.storeGeneratedPdf({
      patientId: consultation.patientId,
      consultationId: consultation.id,
      doctorId: consultation.doctorId!,
      fileName,
      storageKey,
    });
  }
}

/** Trimmed, with an empty string becoming null - blank is not an answer. */
function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function normaliseMedicines(lines: SaveClinicalRecordDto['medicines']): Medicine[] {
  return (lines ?? []).map((line) => ({
    // Preserved when the app is editing a line it already has; assigned fresh
    // for one it does not, so every line stays individually addressable.
    id: line.id ?? randomUUID(),
    name: line.name.trim(),
    dose: line.dose.trim(),
    frequency: line.frequency.trim(),
    duration: line.duration.trim(),
    instructions: trimmed(line.instructions),
    genericName: trimmed(line.genericName),
    route: trimmed(line.route),
    quantity: trimmed(line.quantity),
  }));
}

/**
 * The stored jsonb, read back as medicine lines. Defensive about the shape
 * because jsonb is only as good as what wrote it, and the CHECK guarantees an
 * array and nothing about what is in it.
 */
function medicinesOf(record: Pick<ClinicalRecord, 'medicines'>): Medicine[] {
  return Array.isArray(record.medicines) ? (record.medicines as unknown as Medicine[]) : [];
}

function contentIdsOf(record: Pick<ClinicalRecord, 'recommendedContentIds'>): string[] {
  return Array.isArray(record.recommendedContentIds)
    ? (record.recommendedContentIds as unknown[]).filter(
        (id): id is string => typeof id === 'string',
      )
    : [];
}

function adviceOf(record: ClinicalRecord): ClinicalRecordView['advice'] {
  return {
    covered: record.adviceCovered,
    homePractice: record.adviceHomePractice,
    nextFocus: record.adviceNextFocus,
    warningSigns: record.adviceWarningSigns,
  };
}

/**
 * The same 404 for "no such consultation" and for "not yours". Telling them
 * apart would let anyone holding an id learn that it exists - and this one
 * holds a clinical record.
 */
function notFound(): AppException {
  return new AppException(
    ClinicalError.CONSULTATION_NOT_FOUND,
    'Consultation not found.',
    HttpStatus.NOT_FOUND,
  );
}

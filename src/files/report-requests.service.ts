import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ReportRequest, ReportRequestCategory, ReportRequestStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CONSULTATION_ACCESS, ConsultationAccess } from './consultation-access';
import { FilesError } from './files.errors';

export interface ReportRequestRecord {
  id: string;
  consultationId: string;
  title: string;
  category: ReportRequestCategory;
  reason: string | null;
  status: ReportRequestStatus;
  createdAt: Date;
  /** The files uploaded against it. Empty while the request is still open. */
  fulfilledBy: { id: string; fileName: string; createdAt: Date }[];
}

/**
 * FR-4.9: a doctor asks the patient for a document, in any session, naming what
 * is needed and why. The patient sees open requests and uploads AGAINST the
 * request, so the file arrives labelled instead of as an unexplained
 * attachment.
 *
 * The row carries no patient and no doctor. Both are read through the
 * consultation - the treating doctor is always `consultations.doctor_id` - so
 * there is no second copy of who is involved that could disagree with the
 * booking. It carries no `fulfilled_at` either: the arriving `patient_files`
 * row is that timestamp.
 */
@Injectable()
export class ReportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(CONSULTATION_ACCESS) private readonly consultations: ConsultationAccess,
  ) {}

  /** The doctor raises it, on a consultation that is theirs. */
  async raise(
    input: { consultationId: string; title: string; category: ReportRequestCategory; reason?: string },
    actor: AuthenticatedActor,
  ): Promise<ReportRequestRecord> {
    const consultation = await this.consultations.contextOf(input.consultationId);
    if (!consultation || consultation.doctorId !== actor.id) {
      // To a doctor who is not on it, that consultation does not exist.
      throw consultationNotFound();
    }

    const created = await this.prisma.reportRequest.create({
      data: {
        consultationId: input.consultationId,
        title: input.title.trim(),
        category: input.category,
        reason: input.reason?.trim() || null,
      },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'create',
      entityType: 'report_request',
      entityId: created.id,
      consultationId: created.consultationId,
      metadata: { title: created.title, category: created.category },
    });

    await this.notifications.notify({
      code: 'report_requested',
      to: { patientId: consultation.patientId },
      consultationId: created.consultationId,
      variables: { doctorName: await this.doctorNameOf(actor.id), requestedItem: created.title },
      deepLink: { screen: 'consultation', consultationId: created.consultationId },
    });
    return shape(created, []);
  }

  /**
   * The requests on one consultation, for either party to it.
   *
   * The patient reads this to see what has been asked of them; the doctor reads
   * the same list to see what has come back. One query, because they are
   * looking at the same thing from two sides.
   */
  async listForConsultation(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<ReportRequestRecord[]> {
    const consultation = await this.consultations.contextOf(consultationId);
    if (!consultation) throw consultationNotFound();

    const isTheirs =
      (actor.type === 'patient' && actor.id === consultation.patientId) ||
      (actor.type === 'doctor' && actor.id === consultation.doctorId);
    if (!isTheirs) throw consultationNotFound();

    const rows = await this.prisma.reportRequest.findMany({
      where: { consultationId },
      orderBy: { createdAt: 'desc' },
      include: {
        files: {
          where: { deletedAt: null },
          select: { id: true, fileName: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return rows.map((row) => shape(row, row.files));
  }

  /**
   * Every request still open for this patient, across all their consultations.
   *
   * This is what the patient's own screen shows: "your provider has asked for
   * X". Reading it per consultation would mean a patient with two bookings had
   * to go looking in both to find out what was wanted.
   */
  async openForPatient(patientId: string): Promise<ReportRequestRecord[]> {
    const rows = await this.prisma.reportRequest.findMany({
      where: { status: ReportRequestStatus.open },
      orderBy: { createdAt: 'desc' },
      take: OPEN_REQUEST_LIMIT,
    });

    // Filtered through the consultation rather than by a `patient_id` column
    // this table deliberately does not have. Until M-11 lands, `contextOf`
    // resolves nothing and this is empty - which is correct, because without
    // consultations no request can have been raised.
    const mine: ReportRequestRecord[] = [];
    for (const row of rows) {
      const consultation = await this.consultations.contextOf(row.consultationId);
      if (consultation?.patientId === patientId) mine.push(shape(row, []));
    }
    return mine;
  }

  /**
   * The doctor withdraws a request they no longer need. Only an OPEN one: a
   * request the patient has already answered is a record of what was asked and
   * what arrived, and cancelling it afterwards would rewrite that.
   */
  async cancel(requestId: string, actor: AuthenticatedActor): Promise<ReportRequestRecord> {
    const request = await this.prisma.reportRequest.findUnique({ where: { id: requestId } });
    if (!request) throw requestNotFound();

    const consultation = await this.consultations.contextOf(request.consultationId);
    if (!consultation || consultation.doctorId !== actor.id) throw requestNotFound();

    if (request.status !== ReportRequestStatus.open) {
      throw new AppException(
        FilesError.REPORT_REQUEST_CLOSED,
        `That request is already ${request.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.reportRequest.update({
      where: { id: requestId },
      data: { status: ReportRequestStatus.cancelled },
    });
    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'report_request',
      entityId: requestId,
      consultationId: request.consultationId,
      metadata: { to: 'cancelled' },
    });
    return shape(updated, []);
  }

  private async doctorNameOf(doctorId: string): Promise<string> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { fullName: true },
    });
    return doctor?.fullName ?? 'your provider';
  }
}

/** A patient with more open requests than this has a different problem. */
const OPEN_REQUEST_LIMIT = 200;

function consultationNotFound(): AppException {
  return new AppException(
    FilesError.CONSULTATION_NOT_FOUND,
    'That consultation does not exist.',
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

function shape(
  request: ReportRequest,
  files: { id: string; fileName: string; createdAt: Date }[],
): ReportRequestRecord {
  return {
    id: request.id,
    consultationId: request.consultationId,
    title: request.title,
    category: request.category,
    reason: request.reason,
    status: request.status,
    createdAt: request.createdAt,
    fulfilledBy: files,
  };
}

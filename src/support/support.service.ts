import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Complaint,
  ComplaintCategory,
  ComplaintStatus,
  ConsultationStatus,
  Prisma,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { generateReferenceCode } from '../booking/reference-code';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import {
  ComplaintMessage,
  canWrite,
  isTerminal,
  parseMessages,
  patientVisible,
} from './complaint-thread';
import { SupportError } from './support.errors';

/** FR-17.1. What the patient thought of the consultation. */
export interface FeedbackInput {
  /** 1 to 5. */
  rating: number;
  comment?: string | null;
}

export interface FeedbackRecord {
  consultationId: string;
  rating: number | null;
  comment: string | null;
}

export interface ComplaintInput {
  category: ComplaintCategory;
  subject: string;
  description: string;
  /** Null when it is not about one consultation - billing, or the app itself. */
  consultationId?: string | null;
}

/** What the PATIENT sees. Internal notes are absent, not redacted. */
export interface PatientComplaintView {
  id: string;
  referenceCode: string;
  category: ComplaintCategory;
  subject: string;
  description: string;
  status: ComplaintStatus;
  consultationId: string | null;
  messages: ComplaintMessage[];
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What an ADMIN sees: the same, plus the internal thread and the assignee. */
export interface AdminComplaintView extends PatientComplaintView {
  patientId: string;
  assignedToAdminId: string | null;
}

/** FR-18.8's feedback review, and part of FR-18.6's quality dashboard. */
export interface FeedbackSummary {
  consultationId: string;
  referenceCode: string;
  doctorId: string | null;
  rating: number;
  comment: string | null;
  /** When the consultation was, not when the rating arrived - nothing stores that. */
  consultedAt: Date | null;
}

/**
 * M-19 Feedback and Complaints. Owns `complaints`; writes M-11's two feedback
 * columns.
 *
 * *** THE INTERNAL NOTE IS THE WHOLE DESIGN PROBLEM HERE. ***
 *
 * An admin working a complaint needs somewhere to write "spoke to the provider,
 * they dispute this" while it is open. Without that, the thinking happens in
 * email - invisible to whoever picks the ticket up next. So it goes on the
 * ticket, and the patient must never see it.
 *
 * Two things make that safe rather than hopeful: the patient's view is built by
 * a POSITIVE filter (`isInternal === false`), so a malformed entry is dropped
 * rather than shown; and a patient's own message can never be marked internal,
 * because this service sets the flag rather than the caller.
 *
 * *** FEEDBACK IS NOT A COMPLAINT. *** A rating has no workflow, no thread and
 * no assignee - it is submitted once and read in aggregate, which is why it is
 * two columns on the consultation rather than a table.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -- Feedback (FR-17.1) ---------------------------------------------------

  /**
   * The patient rates the consultation they had.
   *
   * Only after it actually happened. Rating a booking that was cancelled, or
   * one that has not started, would put noise into the provider quality figures
   * FR-18.6 reports - and those figures are read as evidence about a named
   * clinician, so what goes into them matters.
   */
  async submitFeedback(
    consultationId: string,
    input: FeedbackInput,
    actor: AuthenticatedActor,
  ): Promise<FeedbackRecord> {
    const consultation = await this.requirePatients(consultationId, actor);

    if (!RATEABLE.includes(consultation.status)) {
      throw new AppException(
        SupportError.NOT_RATEABLE,
        'You can leave feedback once the consultation has taken place.',
        HttpStatus.CONFLICT,
        { status: consultation.status },
      );
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: {
        feedbackRating: input.rating,
        feedbackComment: input.comment?.trim() || null,
      },
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: actor.id,
      action: 'update',
      entityType: 'consultation_feedback',
      entityId: consultationId,
      consultationId,
      // The rating, not the comment. The comment is the patient's own words
      // about a named clinician, and the audit log is read by more people than
      // the feedback screen is.
      metadata: { rating: input.rating, changed: consultation.feedbackRating !== null },
    });

    return {
      consultationId,
      rating: updated.feedbackRating,
      comment: updated.feedbackComment,
    };
  }

  /** What this patient already said about this consultation, if anything. */
  async myFeedback(consultationId: string, actor: AuthenticatedActor): Promise<FeedbackRecord> {
    const consultation = await this.requirePatients(consultationId, actor);
    return {
      consultationId,
      rating: consultation.feedbackRating,
      comment: consultation.feedbackComment,
    };
  }

  /**
   * FR-18.8's feedback review.
   *
   * Only rows that HAVE a rating: a consultation nobody rated is not a data
   * point, and counting it as one would drag every average towards whatever
   * null sorts as.
   */
  async listFeedback(
    actor: AuthenticatedActor,
    filter: { doctorId?: string; maxRating?: number; limit?: number } = {},
  ): Promise<FeedbackSummary[]> {
    assertPermission(actor, 'operations', 'clinical_governance');

    const rows = await this.prisma.consultation.findMany({
      where: {
        feedbackRating: { not: null, ...(filter.maxRating ? { lte: filter.maxRating } : {}) },
        ...(filter.doctorId ? { doctorId: filter.doctorId } : {}),
      },
      select: {
        id: true,
        referenceCode: true,
        doctorId: true,
        feedbackRating: true,
        feedbackComment: true,
        scheduledStartAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 200),
    });

    return rows.map((row) => ({
      consultationId: row.id,
      referenceCode: row.referenceCode,
      doctorId: row.doctorId,
      // Non-null by the filter above; the type does not know that.
      rating: row.feedbackRating ?? 0,
      comment: row.feedbackComment,
      consultedAt: row.scheduledStartAt,
    }));
  }

  // -- Complaints (FR-17.2, FR-18.8) ----------------------------------------

  /**
   * FR-17.2. Raise one.
   *
   * The reference code is minted here and is the whole of what a patient needs
   * to quote to support. `CX-` rather than a consultation's `CC-`, so whoever
   * takes the call knows which kind of thing they have been given.
   */
  async raiseComplaint(
    input: ComplaintInput,
    actor: AuthenticatedActor,
  ): Promise<PatientComplaintView> {
    const patientId = requirePatient(actor);

    const created = await this.prisma.complaint.create({
      data: {
        referenceCode: generateReferenceCode('CX'),
        patientId,
        // Only their OWN consultation may be named. A complaint pointing at
        // somebody else's appointment would put that id in front of an admin
        // alongside this patient's name.
        consultationId: await this.ownConsultationOrNull(input.consultationId, patientId),
        category: input.category,
        subject: input.subject.trim(),
        description: input.description.trim(),
      },
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: 'complaint',
      entityId: created.id,
      consultationId: created.consultationId,
      metadata: { category: created.category, reference: created.referenceCode },
    });
    return patientView(created);
  }

  /** FR-17.2's tracking. The patient's own complaints. */
  async myComplaints(actor: AuthenticatedActor): Promise<PatientComplaintView[]> {
    const patientId = requirePatient(actor);
    const rows = await this.prisma.complaint.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(patientView);
  }

  async myComplaint(id: string, actor: AuthenticatedActor): Promise<PatientComplaintView> {
    return patientView(await this.requireOwn(id, requirePatient(actor)));
  }

  /** The patient adds to their own open complaint. Never an internal note. */
  async replyAsPatient(
    id: string,
    body: string,
    actor: AuthenticatedActor,
  ): Promise<PatientComplaintView> {
    const patientId = requirePatient(actor);
    const existing = await this.requireOwn(id, patientId);
    if (!canWrite(existing.status)) throw notOpen(existing.status);

    const updated = await this.append(id, {
      authorId: patientId,
      authorRole: 'patient',
      body: body.trim(),
      // *** SET HERE, NOT BY THE CALLER. *** A patient's own words are never
      // hidden from them, and there is no request shape that could ask for it.
      isInternal: false,
      at: new Date().toISOString(),
    });
    return patientView(updated);
  }

  // -- The admin side -------------------------------------------------------

  /** FR-18.8's queue. Open work first, oldest first within it. */
  async listComplaints(
    actor: AuthenticatedActor,
    filter: {
      status?: ComplaintStatus;
      category?: ComplaintCategory;
      unassignedOnly?: boolean;
      limit?: number;
    } = {},
  ): Promise<AdminComplaintView[]> {
    assertPermission(actor, 'operations', 'clinical_governance');
    const rows = await this.prisma.complaint.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.unassignedOnly ? { assignedToAdminId: null } : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      take: Math.min(filter.limit ?? 100, 200),
    });
    return rows.map(adminView);
  }

  async getComplaint(id: string, actor: AuthenticatedActor): Promise<AdminComplaintView> {
    assertPermission(actor, 'operations', 'clinical_governance');
    return adminView(await this.requireExists(id));
  }

  /**
   * Pick it up.
   *
   * Assigning also moves `open` to `in_progress`: a ticket somebody has taken
   * responsibility for is by definition being worked, and asking an admin to
   * click twice to say one thing invites queues full of assigned-but-open
   * tickets that nobody trusts.
   */
  async assign(
    id: string,
    assignToAdminId: string,
    actor: AuthenticatedActor,
  ): Promise<AdminComplaintView> {
    assertPermission(actor, 'operations', 'clinical_governance');
    const existing = await this.requireExists(id);
    if (isTerminal(existing.status)) throw notOpen(existing.status);

    const updated = await this.prisma.complaint.update({
      where: { id },
      data: {
        assignedToAdminId: assignToAdminId,
        status: ComplaintStatus.in_progress,
      },
    });
    await this.record(actor, updated, { assignedTo: assignToAdminId, to: 'in_progress' });
    return adminView(updated);
  }

  /**
   * An admin writes on the ticket - to the patient, or to the file.
   *
   * `isInternal` is the caller's choice HERE and only here, because an internal
   * note is a real need: somewhere to write "spoke to the provider, they
   * dispute this" that the next admin to open the ticket can read.
   */
  async replyAsAdmin(
    id: string,
    body: string,
    isInternal: boolean,
    actor: AuthenticatedActor,
  ): Promise<AdminComplaintView> {
    assertPermission(actor, 'operations', 'clinical_governance');
    const existing = await this.requireExists(id);
    if (!canWrite(existing.status)) throw notOpen(existing.status);

    const updated = await this.append(id, {
      authorId: actor.id,
      authorRole: 'admin',
      body: body.trim(),
      isInternal,
      at: new Date().toISOString(),
    });
    // The FACT of an internal note is audited; its contents are not. The trail
    // records that somebody wrote privately on a ticket, which is what a later
    // question about the handling would ask.
    await this.record(actor, updated, { replied: true, internal: isInternal });
    return adminView(updated);
  }

  /**
   * *** THE TWO ENDINGS (FR-18.8). ***
   *
   * `resolved` means something was done. `rejected` means it was considered and
   * declined - a different outcome, and one the patient is owed as a distinct
   * answer rather than as silence.
   *
   * Both require a note, and both require an assignee, because somebody has to
   * own the decision. Both rules are also CHECKs; this raises them as sentences
   * rather than as constraint violations.
   */
  async close(
    id: string,
    outcome: 'resolved' | 'rejected',
    resolutionNote: string,
    actor: AuthenticatedActor,
  ): Promise<AdminComplaintView> {
    assertPermission(actor, 'operations', 'clinical_governance');
    const existing = await this.requireExists(id);
    if (isTerminal(existing.status)) throw notOpen(existing.status);

    const note = resolutionNote.trim();
    if (note.length === 0) {
      throw new AppException(
        SupportError.RESOLUTION_NOTE_REQUIRED,
        'Say what was decided and why — the patient reads this, and so does anyone who picks the case up later.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Whoever closes it owns it, if nobody had claimed it yet. The CHECK
    // refuses an ending with no owner, and this is the honest way to satisfy
    // it - the alternative is refusing the close and making them click assign.
    const owner = existing.assignedToAdminId ?? actor.id;

    const updated = await this.prisma.complaint.update({
      where: { id },
      data: {
        status: outcome === 'resolved' ? ComplaintStatus.resolved : ComplaintStatus.rejected,
        // Set ONLY on a resolution. A rejection has an outcome but no
        // resolution, and a CHECK holds the two apart.
        resolvedAt: outcome === 'resolved' ? new Date() : null,
        resolutionNote: note,
        assignedToAdminId: owner,
      },
    });

    await this.record(actor, updated, { to: outcome, owner });
    return adminView(updated);
  }

  // -- Internals ------------------------------------------------------------

  /**
   * *** ATOMIC APPEND. ***
   *
   * `messages || $1` in the database rather than read-modify-write here. A
   * patient replying while an admin is writing an internal note is entirely
   * ordinary, and a read-modify-write would drop one of the two silently -
   * losing either the patient's words or the note explaining a decision.
   */
  private async append(id: string, message: ComplaintMessage): Promise<Complaint> {
    await this.prisma.$executeRaw`
      UPDATE complaints
         SET messages = messages || ${JSON.stringify([message])}::jsonb,
             updated_at = now()
       WHERE id = ${id}::uuid
    `;
    const reloaded = await this.prisma.complaint.findUnique({ where: { id } });
    if (!reloaded) throw complaintNotFound();
    return reloaded;
  }

  private async requireExists(id: string): Promise<Complaint> {
    const found = await this.prisma.complaint.findUnique({ where: { id } });
    if (!found) throw complaintNotFound();
    return found;
  }

  /** Theirs, and nobody else's. A 404 either way. */
  private async requireOwn(id: string, patientId: string): Promise<Complaint> {
    const found = await this.prisma.complaint.findFirst({ where: { id, patientId } });
    if (!found) throw complaintNotFound();
    return found;
  }

  private async requirePatients(consultationId: string, actor: AuthenticatedActor) {
    const patientId = requirePatient(actor);
    const found = await this.prisma.consultation.findFirst({
      where: { id: consultationId, patientId },
    });
    if (!found) {
      throw new AppException(
        SupportError.CONSULTATION_NOT_FOUND,
        'Consultation not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }

  private async ownConsultationOrNull(
    consultationId: string | null | undefined,
    patientId: string,
  ): Promise<string | null> {
    if (!consultationId) return null;
    const found = await this.prisma.consultation.findFirst({
      where: { id: consultationId, patientId },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  private async record(
    actor: AuthenticatedActor,
    complaint: Complaint,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'complaint',
      entityId: complaint.id,
      consultationId: complaint.consultationId,
      metadata: metadata as Prisma.InputJsonValue,
    });
  }
}

/**
 * A consultation worth rating is one that HAPPENED.
 *
 * Not a cancellation, not a no-show, not one still waiting. FR-18.6 reads these
 * ratings as evidence about a named clinician, so what goes into them matters
 * more than making the button always work.
 */
const RATEABLE: ConsultationStatus[] = [
  ConsultationStatus.in_progress,
  ConsultationStatus.awaiting_documentation,
  ConsultationStatus.completed,
];

/**
 * The patient's view. Internal notes are ABSENT, not blanked.
 *
 * A redacted entry would still tell the patient that the admin wrote something
 * private about them at 14:32 on Tuesday, which is its own kind of unpleasant.
 */
function patientView(row: Complaint): PatientComplaintView {
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    consultationId: row.consultationId,
    messages: patientVisible(parseMessages(row.messages)),
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The admin's view: built by ADDING to the patient's, so the two cannot drift. */
function adminView(row: Complaint): AdminComplaintView {
  return {
    ...patientView(row),
    // The whole thread, internal notes included. This is the one place they
    // are readable, and the override is deliberate and visible.
    messages: parseMessages(row.messages),
    patientId: row.patientId,
    assignedToAdminId: row.assignedToAdminId,
  };
}

function requirePatient(actor: AuthenticatedActor): string {
  if (actor.type !== 'patient') throw complaintNotFound();
  return actor.id;
}

function complaintNotFound(): AppException {
  return new AppException(
    SupportError.COMPLAINT_NOT_FOUND,
    'Complaint not found.',
    HttpStatus.NOT_FOUND,
  );
}

function notOpen(status: ComplaintStatus): AppException {
  return new AppException(
    SupportError.COMPLAINT_CLOSED,
    `This complaint is ${status.replace(/_/g, ' ')}. Raise a new one if there is more to say.`,
    HttpStatus.CONFLICT,
    { status },
  );
}

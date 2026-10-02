import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ClarificationCase,
  ClarificationStatus,
  ClarificationUrgency,
  DoctorSeniority,
  DoctorVerificationStatus,
  Gender,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClarificationError } from './clarification.errors';
import { describe, scanCase } from './deidentify';
import {
  AUTHOR_MAY_WRITE,
  ASSIGNABLE,
  CLOSEABLE,
  CaseMessage,
  EDITABLE,
  EXPERT_MAY_WRITE,
  MessageType,
  REVIEWABLE,
  parseMessages,
  statusAfterExpertMessage,
} from './thread';

/**
 * The free-text a case can carry, from wherever it arrives - a draft, an edit,
 * a stored row being re-checked at post, or a reply. Every one of these is
 * prose a clinician typed, and every one is scanned.
 */
interface ScannableText {
  title?: string | null;
  /** Not an FR-12.3 field - a free-text guidance area, scanned like the rest. */
  topic?: string | null;
  briefHistory?: string | null;
  diagnosis?: string | null;
  currentPlan?: string | null;
  specificDoubt?: string | null;
  /** The treating doctor answering a clarification request. */
  reply?: string | null;
}

/** FR-12.3's fields, plus `topic`. Everything a reviewer needs and nothing that identifies. */
export interface CaseInput {
  title: string;
  /** Free-text guidance area, e.g. "drug interaction". Not part of FR-12.3. */
  topic?: string | null;
  patientAge?: number | null;
  patientGender?: Gender | null;
  briefHistory: string;
  diagnosis?: string | null;
  currentPlan?: string | null;
  specificDoubt: string;
  urgency?: ClarificationUrgency;
  /** The treating doctor's own reference. Never shown to the reviewer. */
  sourceConsultationId?: string | null;
}

/**
 * What a REVIEWER is shown.
 *
 * Note what is absent: no `sourceConsultationId`, no patient, and no treating
 * doctor's identity beyond what the thread already carries. The expert is
 * answering a clinical question, not auditing a colleague.
 */
export interface ExpertCaseView {
  id: string;
  title: string;
  topic: string | null;
  patientAge: number | null;
  patientGender: Gender | null;
  briefHistory: string;
  diagnosis: string | null;
  currentPlan: string | null;
  specificDoubt: string;
  urgency: ClarificationUrgency;
  status: ClarificationStatus;
  assignedAt: Date | null;
  messages: CaseMessage[];
  attachmentIds: string[];
  createdAt: Date;
}

/** What the AUTHOR sees: the same, plus their own link back to the patient. */
export interface AuthorCaseView extends ExpertCaseView {
  sourceConsultationId: string | null;
  expertDoctorId: string | null;
  postedAt: Date | null;
  closedAt: Date | null;
}

/** An expert an admin may choose from. FR-12.4's first check, as a list. */
export interface EligibleExpert {
  id: string;
  fullName: string;
  specialtyId: string | null;
  /** How much they are already holding, so the queue can be spread. */
  openCases: number;
}

/**
 * M-17 Case Clarification. Owns `clarification_cases`.
 *
 * *** TWO INDEPENDENT CHECKS, AND THE SECOND IS THE ONE THAT MATTERS (FR-12.4). ***
 *
 *   `seniority_level = expert`  says WHO MAY BE ASKED
 *   `expert_doctor_id`          says WHAT THEY MAY SEE
 *
 * Eligibility alone never grants visibility, and the code says so twice: every
 * expert read is filtered by `expertDoctorId` on the row, and being at expert
 * seniority is checked only where an admin is CHOOSING somebody. An expert who
 * is not assigned to a case cannot see it, however senior they are, and there
 * is no listing that would tell them it exists.
 *
 * *** NOTHING HERE REACHES THE PATIENT (FR-12.7). *** There is no patient
 * endpoint, no patient notification and no patient-visible field anywhere in
 * this module. The treating doctor owns all patient communication and remains
 * responsible for the treatment plan; an expert opinion is advice to a
 * clinician, not a message to a patient.
 */
@Injectable()
export class ClarificationService {
  private readonly logger = new Logger(ClarificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // -- Writing the case -----------------------------------------------------

  /**
   * FR-12.1. A draft, visible to nobody but its author.
   *
   * Scanned for identifiers on the way in as well as on the way out. Catching
   * it here means the author is told while they are still writing, rather than
   * being refused at the moment they try to post.
   */
  async createDraft(input: CaseInput, actor: AuthenticatedActor): Promise<AuthorCaseView> {
    const doctorId = requireDoctor(actor);
    this.assertDeidentified(input);

    const created = await this.prisma.clarificationCase.create({
      data: {
        treatingDoctorId: doctorId,
        sourceConsultationId: await this.ownConsultationOrNull(
          input.sourceConsultationId,
          doctorId,
        ),
        title: input.title.trim(),
        topic: input.topic?.trim() || null,
        patientAge: input.patientAge ?? null,
        patientGender: input.patientGender ?? null,
        briefHistory: input.briefHistory.trim(),
        diagnosis: input.diagnosis?.trim() || null,
        currentPlan: input.currentPlan?.trim() || null,
        specificDoubt: input.specificDoubt.trim(),
        urgency: input.urgency ?? ClarificationUrgency.routine,
      },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'create',
      entityType: 'clarification_case',
      entityId: created.id,
      // The consultation, so the trail can answer "which case did this doctor
      // raise about this patient" - which is a question only the audit log and
      // the treating doctor may ever ask.
      consultationId: created.sourceConsultationId,
      metadata: { urgency: created.urgency, status: 'draft' },
    });
    return authorView(created, []);
  }

  /** Editing. Only while it is a draft: nobody may rewrite what an expert read. */
  async updateDraft(
    caseId: string,
    input: CaseInput,
    actor: AuthenticatedActor,
  ): Promise<AuthorCaseView> {
    const doctorId = requireDoctor(actor);
    const existing = await this.requireAuthors(caseId, doctorId);
    if (!EDITABLE.includes(existing.status)) {
      throw new AppException(
        ClarificationError.ALREADY_POSTED,
        'This case has been posted and can no longer be edited.',
        HttpStatus.CONFLICT,
        { status: existing.status },
      );
    }
    this.assertDeidentified(input);

    const updated = await this.prisma.clarificationCase.update({
      where: { id: caseId },
      data: {
        title: input.title.trim(),
        topic: input.topic?.trim() || null,
        patientAge: input.patientAge ?? null,
        patientGender: input.patientGender ?? null,
        briefHistory: input.briefHistory.trim(),
        diagnosis: input.diagnosis?.trim() || null,
        currentPlan: input.currentPlan?.trim() || null,
        specificDoubt: input.specificDoubt.trim(),
        urgency: input.urgency ?? existing.urgency,
      },
    });
    return authorView(updated, await this.attachmentIdsFor(caseId));
  }

  /**
   * FR-12.1. Submit it for an expert.
   *
   * Scanned AGAIN here, not only at draft. The two scans are not redundant: a
   * case can be edited between them, the rules can be tightened between them,
   * and this is the last moment before the text becomes visible to somebody
   * outside the treating relationship. This is the scan that makes M-17's "no
   * shared case holds a direct identifier" true.
   */
  async post(caseId: string, actor: AuthenticatedActor): Promise<AuthorCaseView> {
    const doctorId = requireDoctor(actor);
    const existing = await this.requireAuthors(caseId, doctorId);
    if (existing.status !== ClarificationStatus.draft) {
      throw notInState(existing.status, 'posted');
    }
    this.assertDeidentified(existing);

    const posted = await this.prisma.clarificationCase.update({
      where: { id: caseId },
      data: { status: ClarificationStatus.posted, postedAt: new Date() },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: 'clarification_case',
      entityId: caseId,
      consultationId: posted.sourceConsultationId,
      metadata: { to: 'posted', urgency: posted.urgency },
    });
    return authorView(posted, await this.attachmentIdsFor(caseId));
  }

  // -- Assignment -----------------------------------------------------------

  /**
   * FR-12.4's FIRST check, as a list: who MAY be asked.
   *
   * Expert seniority AND a verified account. A doctor whose approval was
   * withdrawn stops being answerable to for a clinical opinion at the same
   * moment they stop being able to consult.
   */
  async eligibleExperts(
    actor: AuthenticatedActor,
    excludeDoctorId?: string,
  ): Promise<EligibleExpert[]> {
    assertPermission(actor, 'clinical_governance', 'operations');

    const experts = await this.prisma.doctor.findMany({
      where: {
        seniorityLevel: DoctorSeniority.expert,
        verificationStatus: DoctorVerificationStatus.verified,
        ...(excludeDoctorId ? { id: { not: excludeDoctorId } } : {}),
      },
      select: {
        id: true,
        fullName: true,
        specialtyId: true,
        _count: { select: { expertCases: { where: { closedAt: null } } } },
      },
      orderBy: { fullName: 'asc' },
    });

    return experts.map((expert) => ({
      id: expert.id,
      fullName: expert.fullName,
      specialtyId: expert.specialtyId,
      openCases: expert._count.expertCases,
    }));
  }

  /**
   * FR-12.4's SECOND check, written: what they may see.
   *
   * The assignment is the ONLY thing that grants visibility. It is an admin's
   * decision rather than the author's, so a treating doctor cannot route their
   * own case to a friendly colleague, and WHICH admin made it is the audit
   * entry rather than a column - it is a decision, not an attribute.
   */
  async assign(
    caseId: string,
    expertDoctorId: string,
    actor: AuthenticatedActor,
  ): Promise<AuthorCaseView> {
    assertPermission(actor, 'clinical_governance', 'operations');
    const existing = await this.requireExists(caseId);
    if (!ASSIGNABLE.includes(existing.status)) throw notInState(existing.status, 'assigned');

    if (expertDoctorId === existing.treatingDoctorId) {
      throw new AppException(
        ClarificationError.EXPERT_IS_THE_AUTHOR,
        'A case cannot be sent back to the doctor who raised it.',
        HttpStatus.CONFLICT,
      );
    }

    // The eligibility check, at the moment of assignment rather than only when
    // the list was drawn. A doctor can be suspended between the two.
    const expert = await this.prisma.doctor.findFirst({
      where: {
        id: expertDoctorId,
        seniorityLevel: DoctorSeniority.expert,
        verificationStatus: DoctorVerificationStatus.verified,
      },
      select: { id: true },
    });
    if (!expert) {
      throw new AppException(
        ClarificationError.NOT_AN_EXPERT,
        'That doctor is not available as an expert reviewer.',
        HttpStatus.CONFLICT,
      );
    }

    const assigned = await this.prisma.clarificationCase.update({
      where: { id: caseId },
      data: {
        expertDoctorId,
        assignedAt: new Date(),
        status: ClarificationStatus.awaiting_response,
      },
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'clarification_case',
      entityId: caseId,
      consultationId: assigned.sourceConsultationId,
      // WHO assigned it, and to whom. The row carries only the outcome.
      metadata: {
        assignedTo: expertDoctorId,
        from: existing.expertDoctorId,
        urgency: assigned.urgency,
      },
    });

    // No consultationId: the expert must not be handed the link back to the patient.
    await this.tell(expertDoctorId, 'case_assigned', caseId);
    return authorView(assigned, await this.attachmentIdsFor(caseId));
  }

  // -- The discussion -------------------------------------------------------

  /**
   * FR-12.5. The expert comments, raises a consideration, asks for more, or
   * advises bringing follow-up forward.
   *
   * The MESSAGE TYPE drives the status, which is what makes the case queue
   * meaningful: a clarification request puts the case back on the author's
   * desk, everything else puts an answer on it.
   */
  async replyAsExpert(
    caseId: string,
    messageType: MessageType,
    body: string,
    actor: AuthenticatedActor,
  ): Promise<ExpertCaseView> {
    const doctorId = requireDoctor(actor);
    const existing = await this.requireAssignedExperts(caseId, doctorId);
    if (!EXPERT_MAY_WRITE.includes(existing.status)) throw notInState(existing.status, 'answered');

    const updated = await this.append(
      caseId,
      {
        authorId: doctorId,
        authorRole: 'expert',
        messageType,
        body: body.trim(),
        at: new Date().toISOString(),
      },
      statusAfterExpertMessage(messageType),
    );

    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: 'clarification_case',
      entityId: caseId,
      // NOT the consultation. An expert's audit entry must not carry the one
      // link back to the patient they were deliberately not shown.
      metadata: { messageType, to: updated.status },
    });

    await this.tell(
      existing.treatingDoctorId,
      'case_reply',
      caseId,
      existing.sourceConsultationId ?? undefined,
    );
    return expertView(updated, await this.attachmentIdsFor(caseId));
  }

  /** The treating doctor answering a clarification request, or adding context. */
  async replyAsAuthor(
    caseId: string,
    body: string,
    actor: AuthenticatedActor,
  ): Promise<AuthorCaseView> {
    const doctorId = requireDoctor(actor);
    const existing = await this.requireAuthors(caseId, doctorId);
    if (!AUTHOR_MAY_WRITE.includes(existing.status))
      throw notInState(existing.status, 'replied to');
    this.assertDeidentified({ reply: body });

    // Answering a clarification request puts the case back with the expert. A
    // reply on any other state leaves the status where it was: adding context
    // to an answered case does not re-open the question.
    const nextStatus =
      existing.status === ClarificationStatus.clarification_asked
        ? ClarificationStatus.awaiting_response
        : existing.status;

    const updated = await this.append(
      caseId,
      {
        authorId: doctorId,
        authorRole: 'treating_doctor',
        messageType: 'author_reply',
        body: body.trim(),
        at: new Date().toISOString(),
      },
      nextStatus,
    );

    if (existing.expertDoctorId) {
      // No consultationId: same rule as `assign` - the expert never gets the link back to the patient.
      await this.tell(existing.expertDoctorId, 'case_reply', caseId);
    }
    return authorView(updated, await this.attachmentIdsFor(caseId));
  }

  /**
   * *** ATOMIC APPEND. ***
   *
   * `messages || $1` in the database rather than read-modify-write here. Two
   * people replying within the same second is entirely ordinary on an urgent
   * case, and a read-modify-write would silently drop one of the two - which on
   * a clinical thread means an expert's advice vanishing with no trace that it
   * was ever given.
   */
  private async append(
    caseId: string,
    message: CaseMessage,
    status: ClarificationStatus,
  ): Promise<ClarificationCase> {
    await this.prisma.$executeRaw`
      UPDATE clarification_cases
         SET messages = messages || ${JSON.stringify([message])}::jsonb,
             status = ${status}::clarification_status,
             updated_at = now()
       WHERE id = ${caseId}::uuid
    `;
    const reloaded = await this.prisma.clarificationCase.findUnique({ where: { id: caseId } });
    if (!reloaded) throw caseNotFound();
    return reloaded;
  }

  // -- Closing --------------------------------------------------------------

  /** The author has read the advice and weighed it. Only once there is advice. */
  async markReviewed(caseId: string, actor: AuthenticatedActor): Promise<AuthorCaseView> {
    const doctorId = requireDoctor(actor);
    const existing = await this.requireAuthors(caseId, doctorId);
    if (!REVIEWABLE.includes(existing.status)) throw notInState(existing.status, 'reviewed');

    const updated = await this.prisma.clarificationCase.update({
      where: { id: caseId },
      data: { status: ClarificationStatus.reviewed },
    });
    await this.audit.record({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: 'clarification_case',
      entityId: caseId,
      consultationId: updated.sourceConsultationId,
      metadata: { to: 'reviewed' },
    });
    return authorView(updated, await this.attachmentIdsFor(caseId));
  }

  /**
   * Done with. Closeable from anywhere the case has actually started, because
   * a case can stop mattering at any point - the patient improves, or is
   * admitted - and chasing an opinion nobody needs any more helps nobody.
   */
  async close(caseId: string, actor: AuthenticatedActor): Promise<AuthorCaseView> {
    const existing =
      actor.type === 'admin'
        ? await this.requireExistsAsAdmin(caseId, actor)
        : await this.requireAuthors(caseId, requireDoctor(actor));

    if (!CLOSEABLE.includes(existing.status)) throw notInState(existing.status, 'closed');

    const updated = await this.prisma.clarificationCase.update({
      where: { id: caseId },
      data: { status: ClarificationStatus.closed, closedAt: new Date() },
    });
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'clarification_case',
      entityId: caseId,
      consultationId: updated.sourceConsultationId,
      metadata: { to: 'closed', from: existing.status },
    });
    return authorView(updated, await this.attachmentIdsFor(caseId));
  }

  // -- Reading --------------------------------------------------------------

  /** The author's own cases. */
  async listMine(actor: AuthenticatedActor, openOnly = false): Promise<AuthorCaseView[]> {
    const doctorId = requireDoctor(actor);
    const rows = await this.prisma.clarificationCase.findMany({
      where: { treatingDoctorId: doctorId, ...(openOnly ? { closedAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    return rows.map((row) => authorView(row, []));
  }

  /**
   * *** FR-12.4, AND M-17'S COMPLETION CRITERION. ***
   *
   * "An expert account sees only its assigned cases."
   *
   * Filtered by `expertDoctorId` on the row, not by seniority. There is no
   * query in this module that would show an expert a case they hold no
   * assignment on, and no listing that would tell them one exists.
   */
  async listAssignedToMe(actor: AuthenticatedActor, openOnly = true): Promise<ExpertCaseView[]> {
    const doctorId = requireDoctor(actor);
    const rows = await this.prisma.clarificationCase.findMany({
      where: {
        expertDoctorId: doctorId,
        ...(openOnly ? { closedAt: null } : {}),
        // A draft has never been shared. The assignment CHECK makes this
        // unreachable anyway; saying it here means it stays unreachable if the
        // status machine is ever changed.
        status: { not: ClarificationStatus.draft },
      },
      orderBy: [{ urgency: 'desc' }, { assignedAt: 'asc' }],
      take: 100,
    });
    return rows.map((row) => expertView(row, []));
  }

  /** The admin's assignment queue: posted and waiting for somebody. */
  async listAwaitingAssignment(actor: AuthenticatedActor): Promise<AuthorCaseView[]> {
    assertPermission(actor, 'clinical_governance', 'operations');
    const rows = await this.prisma.clarificationCase.findMany({
      where: { status: ClarificationStatus.posted },
      orderBy: [{ urgency: 'desc' }, { postedAt: 'asc' }],
      take: 100,
    });
    return rows.map((row) => authorView(row, []));
  }

  /** One case, as its AUTHOR sees it. */
  async getForAuthor(caseId: string, actor: AuthenticatedActor): Promise<AuthorCaseView> {
    const row = await this.requireAuthors(caseId, requireDoctor(actor));
    return authorView(row, await this.attachmentIdsFor(caseId));
  }

  /** One case, as its assigned EXPERT sees it - without the consultation. */
  async getForExpert(caseId: string, actor: AuthenticatedActor): Promise<ExpertCaseView> {
    const row = await this.requireAssignedExperts(caseId, requireDoctor(actor));
    return expertView(row, await this.attachmentIdsFor(caseId));
  }

  // -- Internals ------------------------------------------------------------

  /**
   * FR-12.2, for the free text. Refuses rather than redacting: silently
   * rewriting a clinician's words would leave them not knowing what the expert
   * was actually shown.
   */
  private assertDeidentified(fields: ScannableText): void {
    const found = scanCase({
      title: fields.title,
      topic: fields.topic,
      briefHistory: fields.briefHistory,
      diagnosis: fields.diagnosis,
      currentPlan: fields.currentPlan,
      specificDoubt: fields.specificDoubt,
      reply: fields.reply,
    });
    if (found.length === 0) return;

    this.logger.warn(
      {
        fields: [...new Set(found.map((item) => item.field))],
        kinds: [...new Set(found.map((i) => i.kind))],
      },
      'Refused a clarification case carrying what looks like a direct identifier',
    );
    throw new AppException(
      ClarificationError.IDENTIFIER_PRESENT,
      describe(found),
      HttpStatus.BAD_REQUEST,
      // The FIELD and the KIND, never the value. Echoing the identifier back
      // would put it in a log and a client error body, which is the opposite
      // of the point.
      { found: found.map((item) => ({ field: item.field, kind: item.kind })) },
    );
  }

  private async requireExists(caseId: string): Promise<ClarificationCase> {
    const found = await this.prisma.clarificationCase.findUnique({ where: { id: caseId } });
    if (!found) throw caseNotFound();
    return found;
  }

  private async requireExistsAsAdmin(
    caseId: string,
    actor: AuthenticatedActor,
  ): Promise<ClarificationCase> {
    assertPermission(actor, 'clinical_governance', 'operations');
    return this.requireExists(caseId);
  }

  /** Its author, and nobody else. A 404 either way. */
  private async requireAuthors(caseId: string, doctorId: string): Promise<ClarificationCase> {
    const found = await this.prisma.clarificationCase.findFirst({
      where: { id: caseId, treatingDoctorId: doctorId },
    });
    if (!found) throw caseNotFound();
    return found;
  }

  /**
   * Its ASSIGNED expert, and nobody else.
   *
   * The filter is on the assignment, not on seniority. An expert holding no
   * assignment on this case gets the same 404 a stranger would - which is what
   * "eligibility alone never grants visibility" means when written down.
   */
  private async requireAssignedExperts(
    caseId: string,
    doctorId: string,
  ): Promise<ClarificationCase> {
    const found = await this.prisma.clarificationCase.findFirst({
      where: {
        id: caseId,
        expertDoctorId: doctorId,
        status: { not: ClarificationStatus.draft },
      },
    });
    if (!found) throw caseNotFound();
    return found;
  }

  /** Only the author's OWN consultation may be referenced. */
  private async ownConsultationOrNull(
    consultationId: string | null | undefined,
    doctorId: string,
  ): Promise<string | null> {
    if (!consultationId) return null;
    const found = await this.prisma.consultation.findFirst({
      where: { id: consultationId, doctorId },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  private async attachmentIdsFor(caseId: string): Promise<string[]> {
    const rows = await this.prisma.patientFile.findMany({
      where: { clarificationCaseId: caseId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Tells a doctor there is something waiting, and nothing about what.
   *
   * `consultationId` is passed only when the recipient is the TREATING
   * doctor - never when telling the expert, who must not be handed the one
   * link back to the patient they were deliberately not shown (same rule as
   * the audit entries in `replyAsExpert`/`assign`).
   */
  private async tell(
    doctorId: string,
    code: 'case_assigned' | 'case_reply',
    caseId: string,
    consultationId?: string,
  ): Promise<void> {
    await this.notifications.notify({
      code,
      to: { doctorId },
      consultationId,
      deepLink: { screen: 'clarificationCase', caseId },
    });
  }
}

/** Everything a reviewer may see. The absences are the point. */
function expertView(row: ClarificationCase, attachmentIds: string[]): ExpertCaseView {
  return {
    id: row.id,
    title: row.title,
    topic: row.topic,
    patientAge: row.patientAge,
    patientGender: row.patientGender,
    briefHistory: row.briefHistory,
    diagnosis: row.diagnosis,
    currentPlan: row.currentPlan,
    specificDoubt: row.specificDoubt,
    urgency: row.urgency,
    status: row.status,
    assignedAt: row.assignedAt,
    messages: parseMessages(row.messages),
    attachmentIds,
    createdAt: row.createdAt,
    // NO sourceConsultationId. NO treatingDoctorId. Built by naming every field
    // rather than by deleting from the row, so a column added later is absent
    // here until somebody decides it belongs.
  };
}

function authorView(row: ClarificationCase, attachmentIds: string[]): AuthorCaseView {
  return {
    ...expertView(row, attachmentIds),
    sourceConsultationId: row.sourceConsultationId,
    expertDoctorId: row.expertDoctorId,
    postedAt: row.postedAt,
    closedAt: row.closedAt,
  };
}

/** Only a doctor raises or reviews a case. Not an admin, and never a patient. */
function requireDoctor(actor: AuthenticatedActor): string {
  if (actor.type !== 'doctor') throw caseNotFound();
  return actor.id;
}

function caseNotFound(): AppException {
  return new AppException(
    ClarificationError.CASE_NOT_FOUND,
    'Case not found.',
    HttpStatus.NOT_FOUND,
  );
}

function notInState(status: ClarificationStatus, action: string): AppException {
  return new AppException(
    ClarificationError.NOT_IN_THAT_STATE,
    `A case that is ${status.replace(/_/g, ' ')} cannot be ${action}.`,
    HttpStatus.CONFLICT,
    { status },
  );
}

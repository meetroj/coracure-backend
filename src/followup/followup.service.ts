import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CheckinStatus,
  Consultation,
  FollowupPathway,
  FollowupStatus,
  SafetyAlertType,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { FollowupError } from './followup.errors';
import {
  Answers,
  CheckinQuestion,
  Evaluation,
  answersSchema,
  evaluate,
  followupDay,
  followupEndsOn,
  parseDoctorQuestions,
  parseQuestions,
  parseRules,
  questionsFor,
  withoutDoctorQuestions,
} from './pathway';
import { SafetyAlertsService } from './safety-alerts.service';

/** What the doctor assigns at the end of a consultation (FR-9.7). */
export interface AssignFollowupInput {
  pathwayCode: string;
  /** Defaults to tomorrow: today's check-in on the day of the consult is noise. */
  startsOn?: Date;
  /** FR-13.8. Collected only; these never affect a status. */
  extraQuestions?: CheckinQuestion[];
}

export interface FollowupPlan {
  consultationId: string;
  status: FollowupStatus;
  pathway: { code: string; name: string; version: number } | null;
  startsOn: Date | null;
  /** starts_on + the PINNED pathway's duration. Computed, never stored. */
  endsOn: Date | null;
  durationDays: number | null;
  /** Which day of the window today is. Null outside it. */
  todayIsDay: number | null;
  extraQuestions: CheckinQuestion[];
}

/** Today's questions, and whether they have already been answered. */
export interface TodaysCheckin {
  consultationId: string;
  checkinDate: Date;
  day: number;
  ofDays: number;
  submitted: boolean;
  questions: (CheckinQuestion & { addedByDoctor: boolean })[];
}

export interface CheckinResult {
  consultationId: string;
  checkinDate: Date;
  /** "Day 3 of 7" - the day just submitted, and the pathway's total. */
  day: number;
  ofDays: number;
  status: CheckinStatus;
  /**
   * *** SRS 6.3. *** True when the day was red, so the app shows emergency
   * guidance IMMEDIATELY rather than waiting for anybody to respond.
   */
  showEmergencyGuidance: boolean;
  /** What fired, in the pathway's own words. Never a diagnosis. */
  reasons: string[];
}

/**
 * M-16 Follow-Up and Patient Safety. Owns `checkin_responses`, and drives
 * `safety_alerts` and `followup_pathways`.
 *
 * *** THE PATHWAY VERSION IS PINNED AT ASSIGNMENT. ***
 * `consultations.followup_pathway_id` points at one VERSION, not at a code, so
 * a patient answers the same questions for all seven days even if an admin
 * publishes a revision on day three. Comparing day two with day six is the
 * whole value of a daily check-in, and it only works if the question did not
 * change underneath.
 *
 * *** ABSENCE IS THE SIGNAL. *** A missed check-in is a MISSING row, not a row
 * saying "not answered". Nothing has to remember to write it, and there is no
 * state where a patient answered and the platform believes they did not.
 */
@Injectable()
export class FollowupService {
  private readonly logger = new Logger(FollowupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: SafetyAlertsService,
  ) {}

  // -- Assignment -----------------------------------------------------------

  /**
   * FR-9.7 and FR-13.7: the treating doctor chooses which pathway this patient
   * gets, from when, and may add questions for them alone.
   *
   * Only after the clinical record is finalised. A follow-up plan is part of
   * the treatment, and assigning one before the consultation has been written
   * up would put a patient on daily check-ins for a case nobody had closed.
   */
  async assign(
    consultationId: string,
    input: AssignFollowupInput,
    actor: AuthenticatedActor,
  ): Promise<FollowupPlan> {
    await this.requireDoctorsOwn(consultationId, actor);

    const record = await this.prisma.clinicalRecord.findUnique({
      where: { consultationId },
      select: { finalisedAt: true },
    });
    if (!record?.finalisedAt) {
      throw new AppException(
        FollowupError.NOT_YET_DOCUMENTED,
        'Finalise the clinical record before starting a follow-up plan.',
        HttpStatus.CONFLICT,
      );
    }

    const pathway = await this.prisma.followupPathway.findFirst({
      where: { code: input.pathwayCode, isCurrent: true },
    });
    if (!pathway) {
      throw new AppException(
        FollowupError.PATHWAY_NOT_FOUND,
        'That follow-up pathway is not available.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Tomorrow by default. A check-in on the day of the consultation asks a
    // patient how the last 24 hours compare with a day that included the
    // appointment, which answers nothing.
    const startsOn = startOfDay(input.startsOn ?? tomorrow());

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: {
        // The VERSION, pinned. Not the code.
        followupPathwayId: pathway.id,
        followupStartsOn: startsOn,
        followupStatus: FollowupStatus.active,
        extraCheckinQuestions: input.extraQuestions ?? [],
      },
    });

    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'followup_assignment',
      entityId: consultationId,
      consultationId,
      metadata: {
        pathway: pathway.code,
        version: pathway.version,
        startsOn: startsOn.toISOString().slice(0, 10),
        extraQuestions: (input.extraQuestions ?? []).length,
      },
    });
    return this.planOf(updated, pathway);
  }

  /** Stop the daily check-ins early. The state no date arithmetic can produce. */
  async cancel(consultationId: string, actor: AuthenticatedActor): Promise<FollowupPlan> {
    const consultation = await this.requireDoctorsOwn(consultationId, actor);
    const updated = await this.prisma.consultation.update({
      where: { id: consultation.id },
      data: { followupStatus: FollowupStatus.cancelled },
    });
    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'followup_assignment',
      entityId: consultationId,
      consultationId,
      metadata: { cancelled: true },
    });
    return this.planOf(updated, await this.pathwayOf(updated));
  }

  // -- The daily check-in ---------------------------------------------------

  /** What the patient is asked today, and whether they have answered it. */
  async todaysCheckin(
    consultationId: string,
    actor: AuthenticatedActor,
    today = new Date(),
  ): Promise<TodaysCheckin> {
    const consultation = await this.requirePatientsOwn(consultationId, actor);
    const { pathway, day } = await this.requireOpenWindow(consultation, today);

    const existing = await this.prisma.checkinResponse.findUnique({
      where: {
        consultationId_checkinDate: { consultationId, checkinDate: startOfDay(today) },
      },
      select: { id: true },
    });

    return {
      consultationId,
      checkinDate: startOfDay(today),
      day,
      ofDays: pathway.durationDays,
      submitted: existing !== null,
      questions: questionsFor(
        parseQuestions(pathway.questions),
        parseDoctorQuestions(consultation.extraCheckinQuestions),
      ),
    };
  }

  /**
   * *** THE DAILY CHECK-IN. FR-13.1 TO FR-13.5. ***
   *
   * The answers are graded against the PINNED pathway, an alert is raised where
   * the grading calls for one, and a red day tells the app to show emergency
   * guidance at once (SRS 6.3) rather than waiting for a human to respond.
   */
  async submitCheckin(
    consultationId: string,
    rawAnswers: unknown,
    actor: AuthenticatedActor,
    today = new Date(),
  ): Promise<CheckinResult> {
    const consultation = await this.requirePatientsOwn(consultationId, actor);
    const { pathway, day } = await this.requireOpenWindow(consultation, today);

    const parsed = answersSchema.safeParse(rawAnswers);
    if (!parsed.success) {
      throw new AppException(
        FollowupError.CHECKIN_INCOMPLETE,
        'Those answers could not be read.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const answers: Answers = parsed.data;

    // *** FR-13.8. *** The doctor's own questions are removed BEFORE grading,
    // so there is no path by which one could influence a safety status. The
    // evaluator never learns they exist.
    const doctorQuestions = parseDoctorQuestions(consultation.extraCheckinQuestions);
    const approved = withoutDoctorQuestions(parseQuestions(pathway.questions), doctorQuestions);
    const outcome = evaluate(approved, parseRules(pathway.redFlagRules), answers);

    if (outcome.unanswered.length > 0) {
      throw new AppException(
        FollowupError.CHECKIN_INCOMPLETE,
        'Please answer every required question.',
        HttpStatus.BAD_REQUEST,
        { unanswered: outcome.unanswered },
      );
    }

    const checkinDate = startOfDay(today);
    let response;
    try {
      response = await this.prisma.checkinResponse.create({
        data: {
          consultationId,
          checkinDate,
          answers: answers,
          status: outcome.status,
        },
      });
    } catch (error) {
      // *** ONE PER DAY. *** The unique index is what enforces it. A second
      // submission must not overwrite an answer a clinician may already have
      // acted on - correcting it is a conversation, not a form resubmission.
      if (isUniqueViolation(error)) {
        throw new AppException(
          FollowupError.ALREADY_CHECKED_IN,
          'You have already checked in today. Your provider can see it.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }

    await this.raiseAlertsFor(consultation, response.id, outcome);

    return {
      consultationId,
      checkinDate,
      day,
      ofDays: pathway.durationDays,
      status: outcome.status,
      // SRS 6.3: shown immediately, by the client, on the strength of this flag
      // alone - it does not wait for the doctor or the coordinator to respond.
      showEmergencyGuidance: outcome.status === CheckinStatus.red,
      reasons: [...outcome.redFlags.map((flag) => flag.reason)],
    };
  }

  /**
   * What a graded day raises.
   *
   * A red day raises ONE alert per distinct red-flag category, not one per rule
   * that fired: two rules describing the same finding are one thing for a
   * coordinator to act on, and a queue with the same patient three times is a
   * queue nobody trusts.
   */
  private async raiseAlertsFor(
    consultation: Consultation,
    checkinResponseId: string,
    outcome: Evaluation,
  ): Promise<void> {
    const patientName = await this.patientNameFor(consultation.patientId);

    if (outcome.status === CheckinStatus.red) {
      const seen = new Set<string>();
      for (const flag of outcome.redFlags) {
        if (seen.has(flag.category)) continue;
        seen.add(flag.category);
        await this.alerts.raise({
          // FR-9.8 keeps a side effect as its own type, because it is acted on
          // differently: it usually means a prescription needs changing rather
          // than that somebody is in danger.
          alertType:
            flag.category === 'medication_side_effect'
              ? SafetyAlertType.medication_side_effect
              : SafetyAlertType.red_flag,
          consultationId: consultation.id,
          checkinResponseId,
          reason: flag.reason,
          patientName,
        });
      }
      return;
    }

    if (outcome.status === CheckinStatus.amber) {
      await this.alerts.raise({
        alertType: SafetyAlertType.amber,
        consultationId: consultation.id,
        checkinResponseId,
        reason: 'A check-in reported worsening, missed medicines or side effects.',
        patientName,
      });
    }
    // Green raises nothing. FR-13.2: check-ins and the care plan continue.
  }

  // -- Reading --------------------------------------------------------------

  /** The plan on one consultation, for either party to it. */
  async planFor(consultationId: string, actor: AuthenticatedActor): Promise<FollowupPlan> {
    const consultation = await this.requireParty(consultationId, actor);
    return this.planOf(consultation, await this.pathwayOf(consultation));
  }

  /** Every day answered so far, for the doctor's review and the patient's own view. */
  async historyFor(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<{ checkinDate: Date; status: CheckinStatus; answers: unknown; submittedAt: Date }[]> {
    await this.requireParty(consultationId, actor);
    const rows = await this.prisma.checkinResponse.findMany({
      where: { consultationId },
      orderBy: { checkinDate: 'asc' },
      select: { checkinDate: true, status: true, answers: true, submittedAt: true },
    });
    return rows;
  }

  // -- Internals ------------------------------------------------------------

  private async pathwayOf(consultation: Consultation): Promise<FollowupPathway | null> {
    if (!consultation.followupPathwayId) return null;
    return this.prisma.followupPathway.findUnique({
      where: { id: consultation.followupPathwayId },
    });
  }

  private planOf(consultation: Consultation, pathway: FollowupPathway | null): FollowupPlan {
    const startsOn = consultation.followupStartsOn;
    const endsOn = startsOn && pathway ? followupEndsOn(startsOn, pathway.durationDays) : null;
    const day = startsOn ? followupDay(startsOn, new Date()) : null;
    return {
      consultationId: consultation.id,
      status: consultation.followupStatus,
      pathway: pathway
        ? { code: pathway.code, name: pathway.name, version: pathway.version }
        : null,
      startsOn,
      endsOn,
      durationDays: pathway?.durationDays ?? null,
      todayIsDay: day !== null && pathway && day >= 1 && day <= pathway.durationDays ? day : null,
      extraQuestions: parseDoctorQuestions(consultation.extraCheckinQuestions),
    };
  }

  /** Active, started, and not yet over. Everything else has nothing to ask. */
  private async requireOpenWindow(
    consultation: Consultation,
    today: Date,
  ): Promise<{ pathway: FollowupPathway; day: number }> {
    if (consultation.followupStatus !== FollowupStatus.active || !consultation.followupStartsOn) {
      throw new AppException(
        FollowupError.FOLLOWUP_NOT_ACTIVE,
        'There is no follow-up running on this consultation.',
        HttpStatus.CONFLICT,
        { followupStatus: consultation.followupStatus },
      );
    }
    const pathway = await this.pathwayOf(consultation);
    if (!pathway) {
      throw new AppException(
        FollowupError.PATHWAY_NOT_FOUND,
        'The follow-up pathway for this consultation is missing.',
        HttpStatus.CONFLICT,
      );
    }

    const day = followupDay(consultation.followupStartsOn, today);
    if (day < 1 || day > pathway.durationDays) {
      throw new AppException(
        FollowupError.OUTSIDE_WINDOW,
        day < 1
          ? 'Your follow-up check-ins have not started yet.'
          : 'Your follow-up period has finished.',
        HttpStatus.CONFLICT,
        {
          day,
          startsOn: consultation.followupStartsOn,
          endsOn: followupEndsOn(consultation.followupStartsOn, pathway.durationDays),
        },
      );
    }
    return { pathway, day };
  }

  private async requireParty(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Consultation> {
    const found = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!found) throw notFound();
    const isParty =
      (actor.type === 'patient' && actor.id === found.patientId) ||
      (actor.type === 'doctor' && actor.id === found.doctorId);
    if (!isParty) throw notFound();
    return found;
  }

  private async requirePatientsOwn(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Consultation> {
    const found = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!found || actor.type !== 'patient' || found.patientId !== actor.id) throw notFound();
    return found;
  }

  private async requireDoctorsOwn(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Consultation> {
    const found = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!found || actor.type !== 'doctor' || found.doctorId !== actor.id) throw notFound();
    return found;
  }

  private async patientNameFor(patientId: string): Promise<string> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { fullName: true },
    });
    return patient?.fullName ?? 'A patient';
  }
}

/** Dates are compared by DAY. A check-in belongs to a date, not an instant. */
export function startOfDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0),
  );
}

function tomorrow(): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

function notFound(): AppException {
  return new AppException(
    FollowupError.CONSULTATION_NOT_FOUND,
    'Consultation not found.',
    HttpStatus.NOT_FOUND,
  );
}

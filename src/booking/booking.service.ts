import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as z from 'zod';
import {
  Consultation,
  ConsultationChannel,
  ConsultationMode,
  ConsultationStatus,
  Prisma,
  RiskCategory,
} from '@prisma/client';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AllocationPolicyService } from '../catalogue/allocation-policy.service';
import { SpecialtiesService } from '../catalogue/specialties.service';
import { AuthenticatedActor } from '../common/auth';
import { EventBus } from '../common/event-bus';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { ConsentsService } from '../legal/consents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PatientProfileService } from '../patients/patient-profile.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AssignmentResult, AssignmentService, HOLDS_TIME } from './assignment.service';
import { BookingError } from './booking.errors';
import { generateReferenceCode } from './reference-code';

declare module '../common/event-bus' {
  interface PlatformEvents {
    /**
     * The call is over and the consultation is waiting to be written up.
     *
     * Published rather than called, because the two modules that care want
     * opposite things and neither may reach into this one: M-13 shuts its
     * instant-consult gate on the provider (FR-10.5), and M-15 opens it again
     * when the record is finalised. M-11 owns the status and knows nothing
     * about either.
     */
    'consultation.documentation_due': {
      consultationId: string;
      doctorId: string;
      mode: ConsultationMode;
    };
    /**
     * A Consult Now request exists with nobody offered it yet. M-13 owns
     * offering - this module only announces that a fresh request is waiting,
     * the same shape as the documentation-due event above.
     */
    'consultation.instant_requested': {
      consultationId: string;
    };
  }
}

export const HOLD_MINUTES_KEY = 'booking.hold_minutes';
/** FR-6.2. Long enough to finish a UPI payment, short enough not to park a slot. */
export const DEFAULT_HOLD_MINUTES = 10;

export interface BookScheduledInput {
  specialtyId: string;
  concernId?: string;
  startsAt: Date;
  /**
   * Video or audio. Defaults to video. *** NOT YET VALIDATED against the
   * assigned slot's own `doctor_availability.channels` *** - doing that
   * properly means teaching `AssignmentService`'s pool matching about channel,
   * not just recording what was asked for. Tracked as a follow-up rather than
   * done here at risk to the allocation engine.
   */
  channel?: ConsultationChannel;
  intakeAnswers?: Record<string, unknown>;
}

export interface ConsultationRecord {
  id: string;
  referenceCode: string;
  /**
   * The id the doctor/admin app needs to call `GET patients/:patientId/card`
   * (FR-9.2's masked initials/age/gender view) - it was missing here, which
   * left that endpoint with nothing to be called with.
   */
  patientId: string;
  status: ConsultationStatus;
  mode: ConsultationMode;
  /** Video or audio. In-person is out of scope for this release (SRS section 11). */
  channel: ConsultationChannel;
  specialtyId: string;
  concernId: string | null;
  doctorId: string | null;
  scheduledStartAt: Date | null;
  durationMinutes: number;
  holdExpiresAt: Date | null;
  /** What the patient pays for this service, quoted before a provider is known. */
  consultationFeeInr: number | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  /** Answers to the specialty's intake form, snapshotted at booking. Was captured but never returned. */
  intakeAnswers: Record<string, unknown> | null;
  /**
   * Derived from `status`, never stored - a second "paid" column could disagree
   * with the status it would be describing. `not_applicable` covers a
   * cancelled or expired booking, where "paid" and "unpaid" are both the
   * wrong question.
   */
  paymentStatus: PaymentStatus;
  /** Only on a single-record read by a doctor or admin. Never on the list, and never on the patient's own view. */
  doctorContext?: DoctorAppointmentContext;
}

export type PaymentStatus = 'unpaid' | 'paid' | 'not_applicable';

/** What FR-9's appointment detail screen needs that a bare booking row can't answer. */
export interface DoctorAppointmentContext {
  /** From `clinical_records`, for THIS consultation. Null until one exists. */
  riskCategory: RiskCategory | null;
  /** Completed or settled consultations between this doctor and this patient, excluding this one. */
  totalPastConsultationsWithDoctor: number;
  hasCurrentTeleconsultationConsent: boolean;
}

/**
 * M-11 Booking. Owns `consultations` - the spine every clinical and financial
 * record hangs from.
 *
 * *** BOOKING AND CONSULTATION ARE ONE ROW. *** There is no holds table and no
 * separate appointment: a row with status `pending_payment` IS the slot hold,
 * and the same row becomes the consultation when payment settles. A hold and
 * the booking it becomes are the same appointment at two moments, so giving
 * them two rows would only create a way for them to disagree.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly assignment: AssignmentService,
    private readonly scheduling: SchedulingService,
    private readonly specialties: SpecialtiesService,
    private readonly profiles: PatientProfileService,
    private readonly consents: ConsentsService,
    private readonly policy: AllocationPolicyService,
    private readonly notifications: NotificationsService,
    private readonly events: EventBus,
  ) {}

  // -- Booking --------------------------------------------------------------

  /**
   * FR-6.1: the patient chooses a service and a time, never a provider.
   *
   * The order of the checks is the order in which each one can save the patient
   * work. Consent and profile first, because neither depends on the pool;
   * assignment next; and the slot hold last, so a slot is never taken off the
   * market for a booking that was going to be refused anyway.
   */
  async bookScheduled(
    patientId: string,
    input: BookScheduledInput,
    actor: AuthenticatedActor,
  ): Promise<ConsultationRecord> {
    // SRS 6.2: consent is captured before teleconsultation. M-03 owns the rule.
    await this.consents.assertTeleconsultationConsent(actor);

    const service = await this.requireBookableService(input.specialtyId);
    const { language, regionId } = await this.requireAssignableProfile(patientId);

    const outcome = await this.assignment.resolve({
      specialtyId: input.specialtyId,
      language,
      regionId,
      at: input.startsAt,
    });
    if (!outcome.assigned) {
      await this.assignment.recordDecision(null, patientId, outcome);
      throw noProviderAvailable(outcome);
    }

    const created = await this.create({
      patientId,
      input,
      outcome,
      feeInr: service.consultationFeeInr,
    });
    await this.assignment.recordDecision(created.id, patientId, outcome);
    await this.announce(created);
    return this.shape(created, service.consultationFeeInr);
  }

  /**
   * FR-6.1's other half: Consult Now. The row is created with no provider and
   * no start time; M-13 offers it, times it out and re-routes it, calling the
   * SAME assignment rules rather than a routing rule of its own.
   *
   * `awaiting_doctor` and not `pending_payment`: an instant request is paid for
   * once a provider accepts (FR-10.2), so there is nothing to hold yet - and a
   * hold with no slot is not a hold.
   */
  async requestInstant(
    patientId: string,
    input: { specialtyId: string; concernId?: string; intakeAnswers?: Record<string, unknown> },
    actor: AuthenticatedActor,
  ): Promise<ConsultationRecord> {
    await this.consents.assertTeleconsultationConsent(actor);
    const service = await this.requireBookableService(input.specialtyId);
    await this.requireAssignableProfile(patientId);

    const created = await this.prisma.consultation.create({
      data: {
        referenceCode: generateReferenceCode(),
        patientId,
        specialtyId: input.specialtyId,
        concernId: input.concernId ?? null,
        mode: ConsultationMode.instant,
        status: ConsultationStatus.awaiting_doctor,
        durationMinutes: DEFAULT_INSTANT_MINUTES,
        intakeAnswers: input.intakeAnswers as Prisma.InputJsonValue | undefined,
      },
    });
    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: 'consultation',
      entityId: created.id,
      consultationId: created.id,
      metadata: { mode: 'instant', specialtyId: input.specialtyId },
    });
    // M-13 offers it to the pool. Published rather than called, for the same
    // reason as `consultation.documentation_due`: this module owns the
    // request, M-13 owns offering it, and neither may reach into the other.
    this.events.publish('consultation.instant_requested', { consultationId: created.id });
    return this.shape(created, service.consultationFeeInr);
  }

  // -- The hold -------------------------------------------------------------

  /**
   * The call M-12's payment webhook makes. Turns the hold into a booking: the
   * status moves on and `hold_expires_at` is CLEARED, so the sweeper that
   * releases abandoned checkouts can never take a paid consultation.
   *
   * Idempotent. A gateway will deliver the same webhook twice, and the second
   * one must not be an error.
   */
  async confirmPayment(consultationId: string): Promise<ConsultationRecord> {
    const consultation = await this.require(consultationId);
    if (consultation.status === ConsultationStatus.scheduled) return this.shape(consultation);
    if (consultation.status !== ConsultationStatus.pending_payment) {
      throw notChangeable(consultation.status);
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.scheduled, holdExpiresAt: null },
    });
    await this.audit.record({
      actorType: 'system',
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'scheduled', from: 'pending_payment' },
    });
    await this.announce(updated);
    return this.shape(updated);
  }

  /**
   * FR-6.2: an abandoned checkout releases the slot.
   *
   * `expired`, not `cancelled`. Nobody decided this, and the cancellation
   * columns exist to record who did - which is why a CHECK refuses a cancelled
   * row with no author. The partial unique index stops covering the row the
   * moment it leaves `pending_payment`, so the slot is free again immediately.
   */
  async releaseExpiredHolds(now = new Date()): Promise<number> {
    const expired = await this.prisma.consultation.findMany({
      where: {
        status: ConsultationStatus.pending_payment,
        holdExpiresAt: { lt: now },
      },
      select: { id: true },
      take: SWEEP_BATCH,
    });
    if (expired.length === 0) return 0;

    const ids = expired.map((row) => row.id);
    const released = await this.prisma.consultation.updateMany({
      where: { id: { in: ids }, status: ConsultationStatus.pending_payment },
      data: { status: ConsultationStatus.expired, holdExpiresAt: null },
    });
    for (const id of ids) {
      await this.audit.record({
        actorType: 'system',
        action: 'update',
        entityType: 'consultation',
        entityId: id,
        consultationId: id,
        metadata: { to: 'expired', reason: 'hold_elapsed' },
      });
    }
    this.logger.log({ released: released.count }, 'Released expired slot holds');
    return released.count;
  }

  // -- Changing a booking ---------------------------------------------------

  /**
   * FR-4.4: the patient declines the provider assigned and asks for another,
   * giving a reason, up to a configured limit per booking.
   *
   * The declines are counted from the AUDIT LOG rather than from a column. Each
   * decline and its reason have to be recorded anyway - "so a provider declined
   * repeatedly is visible to the client rather than invisible" - and a counter
   * beside those entries would be a second copy of their number.
   */
  async declineProvider(
    consultationId: string,
    patientId: string,
    reason: string,
  ): Promise<ConsultationRecord> {
    const consultation = await this.requireOwned(consultationId, patientId);
    if (!HOLDS_TIME.includes(consultation.status) || !consultation.doctorId) {
      throw notChangeable(consultation.status);
    }

    const previous = await this.declinedDoctorIds(consultationId);
    const { maxPatientDeclines } = await this.policy.current();
    if (previous.length >= maxPatientDeclines) {
      throw new AppException(
        BookingError.DECLINE_LIMIT_REACHED,
        `You have already asked for a different provider ${previous.length} time(s). Please continue with the provider assigned, or cancel this booking.`,
        HttpStatus.CONFLICT,
        { maxPatientDeclines },
      );
    }

    const declined = [...previous, consultation.doctorId];
    const { language, regionId } = await this.requireAssignableProfile(patientId);
    const outcome = await this.assignment.resolve({
      specialtyId: consultation.specialtyId,
      language,
      regionId,
      at: consultation.scheduledStartAt ?? new Date(),
      excludeDoctorIds: declined,
    });

    // Recorded whether or not a replacement was found: the decline happened,
    // and the reason is what makes a repeatedly-declined provider visible.
    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'update',
      entityType: 'consultation_decline',
      entityId: consultationId,
      consultationId,
      metadata: {
        declinedDoctorId: consultation.doctorId,
        reason: reason.slice(0, 200),
        declineNumber: declined.length,
        replacementFound: outcome.assigned,
      },
    });

    if (!outcome.assigned) {
      await this.assignment.recordDecision(consultationId, patientId, outcome);
      throw noProviderAvailable(outcome);
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { doctorId: outcome.doctorId, durationMinutes: outcome.durationMinutes },
    });
    await this.assignment.recordDecision(consultationId, patientId, outcome);
    return this.shape(updated);
  }

  /** FR-6.4. Cancelling is allowed until the consultation has started. */
  async cancel(
    consultationId: string,
    actor: AuthenticatedActor,
    reason?: string,
  ): Promise<ConsultationRecord> {
    const consultation = await this.requireParty(consultationId, actor);
    if (!CANCELLABLE.includes(consultation.status)) throw notChangeable(consultation.status);

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: {
        status: ConsultationStatus.cancelled,
        cancelledAt: new Date(),
        cancelledByParty: actor.type,
        cancellationReason: reason?.slice(0, 200) ?? null,
        // The hold goes with it, or a CHECK would refuse the row.
        holdExpiresAt: null,
      },
    });
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'cancelled', by: actor.type, reason: reason?.slice(0, 200) ?? null },
    });
    return this.shape(updated);
  }

  /**
   * FR-6.4: reschedule.
   *
   * A NEW row, linked back through `rescheduled_from_consultation_id`, rather
   * than a moved `scheduled_start_at`. The old time is part of the record - a
   * patient was told it, a provider held it - and the assignment is made again
   * from scratch, because whoever was free on Tuesday may not be free on
   * Thursday, and FR-20.2 is about the time actually being booked.
   */
  async reschedule(
    consultationId: string,
    startsAt: Date,
    actor: AuthenticatedActor,
  ): Promise<ConsultationRecord> {
    const original = await this.requireParty(consultationId, actor);
    if (!CANCELLABLE.includes(original.status)) throw notChangeable(original.status);

    const service = await this.requireBookableService(original.specialtyId);
    const { language, regionId } = await this.requireAssignableProfile(original.patientId);
    const outcome = await this.assignment.resolve({
      specialtyId: original.specialtyId,
      language,
      regionId,
      at: startsAt,
    });
    if (!outcome.assigned) {
      await this.assignment.recordDecision(null, original.patientId, outcome);
      throw noProviderAvailable(outcome);
    }

    const created = await this.create({
      patientId: original.patientId,
      input: {
        specialtyId: original.specialtyId,
        concernId: original.concernId ?? undefined,
        startsAt,
        intakeAnswers: (original.intakeAnswers as Record<string, unknown>) ?? undefined,
      },
      outcome,
      feeInr: service.consultationFeeInr,
      rescheduledFrom: original.id,
      // Already paid for: a reschedule does not charge twice, so the new row
      // starts where the old one had got to. M-12 keeps the payment against
      // the original and follows the chain.
      startAsScheduled: original.status === ConsultationStatus.scheduled,
    });

    await this.prisma.consultation.update({
      where: { id: consultationId },
      data: {
        status: ConsultationStatus.cancelled,
        cancelledAt: new Date(),
        cancelledByParty: actor.type,
        cancellationReason: 'Rescheduled',
        holdExpiresAt: null,
      },
    });
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'cancelled', reason: 'rescheduled', replacedBy: created.id },
    });
    await this.assignment.recordDecision(created.id, original.patientId, outcome);
    await this.announce(created);
    return this.shape(created, service.consultationFeeInr);
  }

  /**
   * FR-20.8: an admin reassigns a consultation to a named provider, with the
   * reason recorded.
   *
   * The only path that names a provider directly. It still refuses one who is
   * not free for the whole slot - an override is a judgement about WHO, not a
   * licence to double-book somebody.
   */
  async overrideProvider(
    consultationId: string,
    doctorId: string,
    reason: string,
    actor: AuthenticatedActor,
  ): Promise<ConsultationRecord> {
    const consultation = await this.require(consultationId);
    if (!HOLDS_TIME.includes(consultation.status)) throw notChangeable(consultation.status);

    // Already theirs. Checked before the availability guard, because that guard
    // would otherwise see THIS consultation occupying the slot and refuse to
    // reassign it to the provider who is already on it.
    if (consultation.doctorId === doctorId) return this.shape(consultation);

    if (consultation.scheduledStartAt) {
      try {
        await this.scheduling.assertFree(doctorId, consultation.scheduledStartAt);
      } catch (error) {
        throw new AppException(
          BookingError.OVERRIDE_NOT_POSSIBLE,
          'That provider is not free for the whole of this slot.',
          HttpStatus.CONFLICT,
          { cause: (error as AppException).code },
        );
      }
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { doctorId },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'consultation_assignment',
      entityId: consultationId,
      consultationId,
      metadata: {
        override: true,
        from: consultation.doctorId,
        to: doctorId,
        reason: reason.slice(0, 200),
      },
    });
    return this.shape(updated);
  }

  // -- The call ------------------------------------------------------------
  //
  // M-14 runs the call but does not own the consultation's status, so the two
  // transitions a call causes are here, next to every other one. They are
  // driven by LiveKit's webhooks rather than by either party pressing
  // anything: what a client claims about a call it is in is not evidence.

  /**
   * The first participant has connected. Called by M-14's webhook.
   *
   * Idempotent, and deliberately silent when the consultation is already
   * `in_progress`: the SECOND party joining fires the same webhook, and so does
   * a reconnect, so this is called several times per call by design.
   *
   * It refuses anything other than `scheduled`, which is the one paid,
   * ready-to-join state both booking modes converge on. A connection to a
   * cancelled or completed consultation should be impossible - no token is
   * minted for one - so arriving here from another status means something has
   * gone wrong and is worth failing on rather than absorbing.
   */
  async markInProgress(consultationId: string): Promise<ConsultationRecord> {
    const consultation = await this.require(consultationId);
    if (consultation.status === ConsultationStatus.in_progress) return this.shape(consultation);
    if (consultation.status !== ConsultationStatus.scheduled) {
      throw notChangeable(consultation.status);
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.in_progress },
    });
    await this.audit.record({
      actorType: 'system',
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'in_progress', from: 'scheduled' },
    });
    return this.shape(updated);
  }

  /**
   * The room has closed. Called by M-14's webhook on `room_finished`.
   *
   * `awaiting_documentation`, not `completed`: the consultation is not finished
   * until M-15's clinical record is, and the case-completion rule is enforced by
   * the system rather than by convention. This only says the talking is over.
   *
   * A room that closes having never been joined leaves the status alone. LiveKit
   * closes an empty room after its idle timeout whether anybody arrived or not,
   * and a consultation nobody attended is a no-show or a cancellation - neither
   * of which is documentation waiting to be written.
   */
  async markCallEnded(consultationId: string): Promise<ConsultationRecord> {
    const consultation = await this.require(consultationId);
    if (consultation.status !== ConsultationStatus.in_progress) return this.shape(consultation);

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.awaiting_documentation },
    });
    await this.audit.record({
      actorType: 'system',
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'awaiting_documentation', from: 'in_progress' },
    });

    // FR-10.5's gate is M-13's, and opening it again is M-15's. This module
    // only says the documentation is now due.
    if (updated.doctorId) {
      this.events.publish('consultation.documentation_due', {
        consultationId,
        doctorId: updated.doctorId,
        mode: updated.mode,
      });
    }
    return this.shape(updated);
  }

  /**
   * No-show marking. The party with no participant row is the one who missed it,
   * and that is now CHECKED rather than merely intended: before M-14 existed
   * there were no participant rows to check against, and this took the caller's
   * word for it.
   *
   * `in_progress` and `awaiting_documentation` are markable for the same
   * reason. The commonest no-show by far is the doctor joining at the appointed
   * time and waiting alone - which, once a call can start, is a consultation
   * that reached `in_progress` on one connection and then ended. Refusing those
   * two statuses would leave exactly that case with nowhere to go.
   */
  async markNoShow(consultationId: string, actor: AuthenticatedActor): Promise<ConsultationRecord> {
    const consultation = await this.requireParty(consultationId, actor);
    if (!NO_SHOW_FROM.includes(consultation.status)) throw notChangeable(consultation.status);

    // M-14 owns every WRITE to this table; this is a read, and the only one
    // outside that module. Both parties having connected is not a no-show
    // whatever anybody says afterwards, and the row is the evidence.
    const attended = await this.prisma.consultationParticipant.findMany({
      where: { consultationId },
      distinct: ['party'],
      select: { party: true },
    });
    if (attended.length >= 2) {
      throw new AppException(
        BookingError.NOT_CHANGEABLE,
        'Both of you joined this consultation, so it cannot be marked a no-show.',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.no_show },
    });
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'consultation',
      entityId: consultationId,
      consultationId,
      metadata: { to: 'no_show' },
    });
    return this.shape(updated);
  }

  // -- Reading --------------------------------------------------------------

  /** FR-6.5: upcoming and past, for whichever party is asking. */
  async listFor(
    actor: AuthenticatedActor,
    filter: { upcoming?: boolean; limit?: number } = {},
  ): Promise<ConsultationRecord[]> {
    const mine: Prisma.ConsultationWhereInput =
      actor.type === 'doctor' ? { doctorId: actor.id } : { patientId: actor.id };
    const upcoming = filter.upcoming ?? true;

    const rows = await this.prisma.consultation.findMany({
      where: {
        ...mine,
        ...(upcoming ? { status: { in: HOLDS_TIME } } : { status: { notIn: HOLDS_TIME } }),
      },
      orderBy: upcoming
        ? [{ scheduledStartAt: 'asc' }, { createdAt: 'asc' }]
        : [{ scheduledStartAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(filter.limit ?? 50, 100),
    });
    return rows.map((row) => this.shape(row));
  }

  async getForActor(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<ConsultationRecord> {
    const consultation = await this.requireParty(consultationId, actor);
    const fee = await this.specialties
      .listServices()
      .then(
        (services) =>
          services.find((s) => s.id === consultation.specialtyId)?.consultationFeeInr ?? null,
      );
    const record = this.shape(consultation, fee);
    if (actor.type === 'doctor' || actor.type === 'admin') {
      record.doctorContext = await this.doctorContextOf(consultation);
    }
    return record;
  }

  /**
   * FR-9's appointment detail: risk category, how many times this doctor has
   * already treated this patient, and whether teleconsultation consent is
   * current. One extra lookup, only on a single-record read - never per row
   * on the list.
   */
  private async doctorContextOf(consultation: Consultation): Promise<DoctorAppointmentContext> {
    const [clinicalRecord, totalPastConsultationsWithDoctor, hasCurrentTeleconsultationConsent] =
      await Promise.all([
        this.prisma.clinicalRecord.findUnique({
          where: { consultationId: consultation.id },
          select: { riskCategory: true },
        }),
        consultation.doctorId
          ? this.prisma.consultation.count({
              where: {
                doctorId: consultation.doctorId,
                patientId: consultation.patientId,
                id: { not: consultation.id },
                status: { notIn: [ConsultationStatus.cancelled, ConsultationStatus.expired] },
              },
            })
          : Promise.resolve(0),
        this.consents.hasCurrentConsent(
          { type: 'patient', id: consultation.patientId },
          'teleconsultation_consent',
        ),
      ]);
    return {
      riskCategory: clinicalRecord?.riskCategory ?? null,
      totalPastConsultationsWithDoctor,
      hasCurrentTeleconsultationConsent,
    };
  }

  /** The declines already made on one booking, newest last. */
  async declinedDoctorIds(consultationId: string): Promise<string[]> {
    const entries = await this.prisma.auditLog.findMany({
      where: { entityType: 'consultation_decline', entityId: consultationId },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    return entries
      .map((entry) => (entry.metadata as { declinedDoctorId?: string } | null)?.declinedDoctorId)
      .filter((id): id is string => typeof id === 'string');
  }

  // -- Internals ------------------------------------------------------------

  private async create(args: {
    patientId: string;
    input: BookScheduledInput;
    outcome: Extract<AssignmentResult, { assigned: true }>;
    feeInr: number;
    rescheduledFrom?: string;
    startAsScheduled?: boolean;
  }): Promise<Consultation> {
    // *** THE FIRST LOCK. *** M-07 refuses a slot that was never offered or is
    // already taken, and gives the clear message. The unique index below is the
    // last word, for the two requests that both get past this.
    await this.scheduling.assertFree(args.outcome.doctorId, args.input.startsAt);

    // A free service has nothing to pay for, so there is nothing to hold: it is
    // booked outright. M-06 allows a zero fee deliberately, and a hold that
    // could never be settled would expire every such booking.
    const free = args.feeInr <= 0 || args.startAsScheduled === true;
    const holdMinutes = await this.holdMinutes();

    try {
      return await this.prisma.consultation.create({
        data: {
          referenceCode: generateReferenceCode(),
          patientId: args.patientId,
          doctorId: args.outcome.doctorId,
          specialtyId: args.input.specialtyId,
          concernId: args.input.concernId ?? null,
          mode: ConsultationMode.scheduled,
          channel: args.input.channel ?? ConsultationChannel.video,
          status: free ? ConsultationStatus.scheduled : ConsultationStatus.pending_payment,
          scheduledStartAt: args.input.startsAt,
          durationMinutes: args.outcome.durationMinutes,
          holdExpiresAt: free ? null : new Date(Date.now() + holdMinutes * 60_000),
          intakeAnswers: args.input.intakeAnswers as Prisma.InputJsonValue | undefined,
          rescheduledFromConsultationId: args.rescheduledFrom ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The partial unique index fired: another request wrote the same
        // (doctor, start) between our check and our write.
        throw new AppException(
          BookingError.SLOT_TAKEN,
          'That time was taken a moment ago. Please choose another.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private async holdMinutes(): Promise<number> {
    const value = await this.config.get(HOLD_MINUTES_KEY, HOLD_MINUTES_SCHEMA);
    return value ?? DEFAULT_HOLD_MINUTES;
  }

  private async requireBookableService(specialtyId: string) {
    const service = (await this.specialties.listServices()).find((s) => s.id === specialtyId);
    if (!service) {
      throw new AppException(
        BookingError.SERVICE_NOT_AVAILABLE,
        'That service is not available.',
        HttpStatus.NOT_FOUND,
      );
    }
    return service;
  }

  /**
   * FR-20.10: the preferred language and the region are collected in the
   * profile, and "without it FR-20.2 has nothing to match on".
   *
   * Language is refused when missing because it cannot be relaxed. A missing
   * REGION is allowed through - it is only a preference, and refusing a booking
   * over an unset preference would be worse than assigning without it.
   */
  private async requireAssignableProfile(
    patientId: string,
  ): Promise<{ language: string; regionId: string | null }> {
    const profile = await this.profiles.getOwn(patientId);
    if (!profile.preferredLanguage) {
      throw new AppException(
        BookingError.PROFILE_INCOMPLETE,
        'Please set your preferred language before booking, so we can match you with a provider who speaks it.',
        HttpStatus.CONFLICT,
        { missing: ['preferredLanguage'] },
      );
    }
    return { language: profile.preferredLanguage, regionId: profile.regionId };
  }

  private async require(consultationId: string): Promise<Consultation> {
    const found = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!found) throw consultationNotFound();
    return found;
  }

  private async requireOwned(consultationId: string, patientId: string): Promise<Consultation> {
    const found = await this.prisma.consultation.findFirst({
      where: { id: consultationId, patientId },
    });
    if (!found) throw consultationNotFound();
    return found;
  }

  /** Either party to it, or an admin. To anyone else it does not exist. */
  private async requireParty(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Consultation> {
    const consultation = await this.require(consultationId);
    const isParty =
      (actor.type === 'patient' && actor.id === consultation.patientId) ||
      (actor.type === 'doctor' && actor.id === consultation.doctorId) ||
      actor.type === 'admin';
    if (!isParty) throw consultationNotFound();
    return consultation;
  }

  /** Never breaks a booking: `notify` swallows its own failures (M-08). */
  private async announce(consultation: Consultation): Promise<void> {
    if (consultation.status !== ConsultationStatus.scheduled || !consultation.doctorId) return;
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: consultation.doctorId },
      select: { fullName: true },
    });
    await this.notifications.notify({
      code: 'booking_confirmed',
      to: { patientId: consultation.patientId },
      consultationId: consultation.id,
      variables: {
        doctorName: doctor?.fullName ?? 'your provider',
        consultationTime: consultation.scheduledStartAt?.toISOString() ?? '',
      },
      deepLink: { screen: 'consultation', consultationId: consultation.id },
    });
  }

  private shape(consultation: Consultation, feeInr: number | null = null): ConsultationRecord {
    return {
      id: consultation.id,
      referenceCode: consultation.referenceCode,
      patientId: consultation.patientId,
      status: consultation.status,
      mode: consultation.mode,
      channel: consultation.channel,
      specialtyId: consultation.specialtyId,
      concernId: consultation.concernId,
      doctorId: consultation.doctorId,
      scheduledStartAt: consultation.scheduledStartAt,
      durationMinutes: consultation.durationMinutes,
      holdExpiresAt: consultation.holdExpiresAt,
      consultationFeeInr: feeInr,
      cancelledAt: consultation.cancelledAt,
      cancellationReason: consultation.cancellationReason,
      createdAt: consultation.createdAt,
      intakeAnswers: (consultation.intakeAnswers as Record<string, unknown> | null) ?? null,
      paymentStatus: paymentStatusOf(consultation.status),
    };
  }
}

/** `pending_payment` is the only status that means the fee is still owed. */
export function paymentStatusOf(status: ConsultationStatus): PaymentStatus {
  if (status === ConsultationStatus.cancelled || status === ConsultationStatus.expired) {
    return 'not_applicable';
  }
  return status === ConsultationStatus.pending_payment ? 'unpaid' : 'paid';
}

/** Statuses a booking can still be called off from. */
const CANCELLABLE: ConsultationStatus[] = [
  ConsultationStatus.pending_payment,
  ConsultationStatus.scheduled,
  ConsultationStatus.awaiting_doctor,
];

/** A no-show is only meaningful once somebody was expected. */
const NO_SHOW_FROM: ConsultationStatus[] = [
  ConsultationStatus.scheduled,
  ConsultationStatus.awaiting_doctor,
  // Both added with M-14. A call one party joined alone passes THROUGH
  // `in_progress` on their connection and ends in `awaiting_documentation`, so
  // without these two the commonest no-show of all could never be recorded.
  ConsultationStatus.in_progress,
  ConsultationStatus.awaiting_documentation,
];

/** An instant consult's length before a provider with their own is known. */
const DEFAULT_INSTANT_MINUTES = 30;
/** One sweep releases at most this many, so a backlog cannot stall a tick. */
const SWEEP_BATCH = 500;

const HOLD_MINUTES_SCHEMA = z.number().int().min(1).max(120);

function consultationNotFound(): AppException {
  return new AppException(
    BookingError.CONSULTATION_NOT_FOUND,
    'That consultation does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

function notChangeable(status: ConsultationStatus): AppException {
  return new AppException(
    BookingError.NOT_CHANGEABLE,
    `This consultation is ${status.replace(/_/g, ' ')} and cannot be changed.`,
    HttpStatus.CONFLICT,
  );
}

/**
 * FR-20.7: the patient is told plainly, and offered the next time the pool can
 * cover it. Never a silent fallback to a provider who does not meet the
 * criteria - which is why this is an error and not a partial result.
 */
function noProviderAvailable(
  outcome: Extract<AssignmentResult, { assigned: false }>,
): AppException {
  const when = outcome.soonestAvailableAt;
  return new AppException(
    BookingError.NO_PROVIDER_AVAILABLE,
    when
      ? 'No provider is free for that time. The next time we can cover this service is shown below.'
      : 'No provider is free for that time, and none is available in the next few weeks.',
    HttpStatus.CONFLICT,
    { soonestAvailableAt: when?.toISOString() ?? null, reason: outcome.reason },
  );
}

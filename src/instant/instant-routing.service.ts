import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConsultationStatus,
  DoctorPresence,
  Gender,
  InstantConsultancy,
  InstantConsultancyOutcome,
} from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AssignmentService } from '../booking/assignment.service';
import { PaymentStatus, paymentStatusOf } from '../booking/booking.service';
import { AuthenticatedActor } from '../common/auth';
import { PlatformEvents } from '../common/event-bus';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ageFrom, initialsOf } from '../patients/date-of-birth';
import { PatientProfileService } from '../patients/patient-profile.service';
import { InstantError } from './instant.errors';
import { PresenceService } from './presence.service';

export const ACCEPTANCE_WINDOW_KEY = 'instant.acceptance_window_seconds';
/** FR-10.6. Long enough to notice a push, short enough that a patient waits once. */
export const DEFAULT_ACCEPTANCE_WINDOW_SECONDS = 45;

const WINDOW = z.number().int().min(10).max(300);

export interface OfferRecord {
  id: string;
  consultationId: string;
  /** Was missing, leaving nothing to resolve the masked identity below (or `GET patients/:id/card`) from. */
  patientId: string;
  /** FR-9.2's masked identity - never a name, same as the appointment card. */
  patientInitials: string | null;
  patientAge: number | null;
  patientGender: Gender;
  /** The service, e.g. "Psychiatry" - the "condition" a doctor's app can be shown pre-consult. */
  specialtyName: string;
  /** The matched concern, if search mapped one. Never the free-text intake answer (FR-16.2's rule). */
  concernName: string | null;
  /** The patient's one stored preferred language - never a list, there is no second one to show. */
  preferredLanguage: string;
  /** Derived from the consultation's status, same as `ConsultationRecord.paymentStatus`. */
  paymentStatus: PaymentStatus;
  doctorId: string;
  attemptNumber: number;
  outcome: InstantConsultancyOutcome;
  offeredAt: Date;
  expiresAt: Date;
}

/**
 * M-13's second half: getting an instant request in front of somebody.
 *
 * *** THE ROUTING RULE IS M-11'S, NOT THIS MODULE'S. *** MODULES is explicit:
 * a decline or timeout re-routes "chosen by M-11's assignment rules rather than
 * by a routing rule of its own". So this service decides WHEN to offer and to
 * WHOM NOT to re-offer; the question of who is next is asked of
 * `AssignmentService`, exactly as a scheduled booking asks it.
 *
 * That matters most for language. FR-20.4 makes it a hard requirement, and a
 * separate routing rule here would be a second place for it to be forgotten -
 * so a timeout at 2am can never land a patient with a provider who cannot speak
 * to them.
 */
@Injectable()
export class InstantRoutingService {
  private readonly logger = new Logger(InstantRoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly assignment: AssignmentService,
    private readonly presence: PresenceService,
    private readonly profiles: PatientProfileService,
    private readonly notifications: NotificationsService,
  ) {}

  // -- Offering -------------------------------------------------------------

  /**
   * M-11 announces a fresh Consult Now request; this is what actually offers
   * it to somebody. A listener rather than a call from `BookingService`, for
   * the same reason `PresenceService` listens for `documentation_due`: M-11
   * owns the request, M-13 owns offering it, and neither module reaches into
   * the other.
   */
  @OnEvent('consultation.instant_requested')
  async onInstantRequested(
    event: PlatformEvents['consultation.instant_requested'],
  ): Promise<void> {
    try {
      await this.offerNext(event.consultationId);
    } catch (error) {
      // A request cancelled between creation and this handler running throws
      // here, and that is not a lost offer - there is nothing left to offer.
      this.logger.debug(
        { err: error, consultationId: event.consultationId },
        'No first offer made',
      );
    }
  }

  /**
   * Offers the request to the next provider who has not already been tried.
   *
   * Called when the request is created (via the listener above), and again on
   * every decline and every timeout. Returns null when nobody is left - the
   * caller decides what to tell the patient, because "nobody now" means
   * something different at the first attempt than at the fifth.
   */
  async offerNext(consultationId: string): Promise<OfferRecord | null> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation) throw requestNotFound();
    if (consultation.status !== ConsultationStatus.awaiting_doctor) {
      throw new AppException(
        InstantError.REQUEST_CLOSED,
        'This request is no longer waiting for a provider.',
        HttpStatus.CONFLICT,
      );
    }

    const previous = await this.prisma.instantConsultancy.findMany({
      where: { consultationId },
      orderBy: { attemptNumber: 'desc' },
    });
    // Everyone already tried is excluded, whatever they said. A provider who
    // declined must not be asked the same question again a second later.
    const alreadyTried = previous.map((offer) => offer.doctorId);

    const profile = await this.profiles.getOwn(consultation.patientId);
    const outcome = await this.assignment.resolve({
      specialtyId: consultation.specialtyId,
      language: profile.preferredLanguage,
      regionId: profile.regionId,
      at: new Date(),
      excludeDoctorIds: alreadyTried,
    });
    await this.assignment.recordDecision(consultationId, consultation.patientId, outcome);
    if (!outcome.assigned) return null;

    // Available now, permitted, and not held by unfinished paperwork. The
    // assignment engine knows about diaries and languages; only this module
    // knows whether somebody is actually at their desk.
    const ready = await this.presence.of(outcome.doctorId);
    if (!ready.canReceiveInstant) {
      // Not an error: try the next one. This is the commonest case at any hour
      // when most of the pool is offline.
      return this.offerAfterSkipping(consultationId, [...alreadyTried, outcome.doctorId]);
    }

    return this.open(consultation.id, outcome.doctorId, previous[0]?.attemptNumber ?? 0);
  }

  /**
   * The same, having ruled somebody out. Bounded, so a pool where nobody is at
   * their desk cannot spin: each pass excludes one more provider, so it ends.
   */
  private async offerAfterSkipping(
    consultationId: string,
    exclude: string[],
  ): Promise<OfferRecord | null> {
    if (exclude.length > MAX_ROUTING_ATTEMPTS) return null;

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation) return null;
    const profile = await this.profiles.getOwn(consultation.patientId);

    const outcome = await this.assignment.resolve({
      specialtyId: consultation.specialtyId,
      language: profile.preferredLanguage,
      regionId: profile.regionId,
      at: new Date(),
      excludeDoctorIds: exclude,
    });
    if (!outcome.assigned) return null;

    const ready = await this.presence.of(outcome.doctorId);
    if (!ready.canReceiveInstant) {
      return this.offerAfterSkipping(consultationId, [...exclude, outcome.doctorId]);
    }

    const last = await this.prisma.instantConsultancy.findFirst({
      where: { consultationId },
      orderBy: { attemptNumber: 'desc' },
    });
    return this.open(consultationId, outcome.doctorId, last?.attemptNumber ?? 0);
  }

  /** Writes the offer, moves the provider, and tells them (FR-16.4). */
  private async open(
    consultationId: string,
    doctorId: string,
    lastAttempt: number,
  ): Promise<OfferRecord> {
    const seconds = await this.acceptanceWindowSeconds();
    const offer = await this.prisma.instantConsultancy.create({
      data: {
        consultationId,
        doctorId,
        attemptNumber: lastAttempt + 1,
        expiresAt: new Date(Date.now() + seconds * 1000),
      },
    });

    await this.presence.moveTo(doctorId, DoctorPresence.request_pending);
    await this.audit.record({
      actorType: 'system',
      action: 'create',
      entityType: 'instant_offer',
      entityId: offer.id,
      consultationId,
      metadata: { doctorId, attemptNumber: offer.attemptNumber, expiresInSeconds: seconds },
    });

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { specialty: { select: { name: true } } },
    });
    await this.notifications.notify({
      code: 'instant_request',
      to: { doctorId },
      consultationId,
      variables: { serviceName: consultation?.specialty.name ?? 'a consultation' },
      deepLink: { screen: 'instantRequest', consultationId },
    });
    return this.withPatientAndService(offer);
  }

  // -- Answering ------------------------------------------------------------

  /**
   * The provider takes it.
   *
   * The write is conditional on the offer still being `pending`, so two
   * providers racing to accept cannot both win - and the partial unique index
   * over accepted rows is the last word if they somehow do.
   */
  async accept(consultationId: string, actor: AuthenticatedActor): Promise<OfferRecord> {
    const offer = await this.requireOpenOffer(consultationId, actor.id);

    const taken = await this.prisma.instantConsultancy.updateMany({
      where: { id: offer.id, outcome: InstantConsultancyOutcome.pending },
      data: { outcome: InstantConsultancyOutcome.accepted },
    });
    if (taken.count === 0) throw offerClosed();

    await this.prisma.$transaction([
      // The consultation gets its provider. `awaiting_doctor` -> the patient
      // pays, then the call starts, which is M-12's and M-14's to drive.
      this.prisma.consultation.update({
        where: { id: consultationId },
        data: { doctorId: actor.id, status: ConsultationStatus.pending_payment },
      }),
      // Every other open offer for this request is now moot.
      this.prisma.instantConsultancy.updateMany({
        where: { consultationId, outcome: InstantConsultancyOutcome.pending },
        data: { outcome: InstantConsultancyOutcome.superseded },
      }),
    ]);

    await this.presence.moveTo(actor.id, DoctorPresence.in_consultation);
    await this.audit.record({
      actorType: 'doctor',
      actorId: actor.id,
      action: 'update',
      entityType: 'instant_offer',
      entityId: offer.id,
      consultationId,
      metadata: { outcome: 'accepted', attemptNumber: offer.attemptNumber },
    });

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { patientId: true },
    });
    if (consultation) {
      await this.notifications.notify({
        code: 'doctor_joined',
        to: { patientId: consultation.patientId },
        consultationId,
        variables: { doctorName: await this.nameOf(actor.id) },
        deepLink: { screen: 'consultation', consultationId },
      });
    }
    return this.withPatientAndService({ ...offer, outcome: InstantConsultancyOutcome.accepted });
  }

  /**
   * The provider passes. Re-routed immediately, WITHOUT the patient doing
   * anything - which is the done-when for this module.
   */
  async decline(consultationId: string, actor: AuthenticatedActor): Promise<{ rerouted: boolean }> {
    const offer = await this.requireOpenOffer(consultationId, actor.id);
    await this.close(offer, InstantConsultancyOutcome.declined);
    return { rerouted: (await this.offerNext(consultationId)) !== null };
  }

  /**
   * FR-10.6's timeout, swept rather than timed in memory.
   *
   * A per-offer timer would live in one process and die with it, so a restart
   * mid-window would leave a request offered to somebody who never answers and
   * a patient waiting on nothing.
   */
  async expireOpenOffers(now = new Date()): Promise<number> {
    const stale = await this.prisma.instantConsultancy.findMany({
      where: { outcome: InstantConsultancyOutcome.pending, expiresAt: { lt: now } },
      take: SWEEP_BATCH,
    });
    if (stale.length === 0) return 0;

    for (const offer of stale) {
      const closed = await this.prisma.instantConsultancy.updateMany({
        where: { id: offer.id, outcome: InstantConsultancyOutcome.pending },
        data: { outcome: InstantConsultancyOutcome.timed_out },
      });
      // Somebody answered between the read and the write. Leave them alone.
      if (closed.count === 0) continue;

      await this.freeIfIdle(offer.doctorId);
      await this.audit.record({
        actorType: 'system',
        action: 'update',
        entityType: 'instant_offer',
        entityId: offer.id,
        consultationId: offer.consultationId,
        metadata: { outcome: 'timed_out', attemptNumber: offer.attemptNumber },
      });

      try {
        await this.offerNext(offer.consultationId);
      } catch (error) {
        // A request that has since been cancelled or answered throws here, and
        // that is not a sweep failure - the other offers still need expiring.
        this.logger.debug({ err: error, consultationId: offer.consultationId }, 'No re-route');
      }
    }
    return stale.length;
  }

  /** The offers on one request, in the order they were made. */
  async offersFor(consultationId: string): Promise<OfferRecord[]> {
    const rows = await this.prisma.instantConsultancy.findMany({
      where: { consultationId },
      orderBy: { attemptNumber: 'asc' },
    });
    return this.withPatientsAndServices(rows);
  }

  /** What is open for this provider right now, for their app to show. */
  async openOffersFor(doctorId: string): Promise<OfferRecord[]> {
    const rows = await this.prisma.instantConsultancy.findMany({
      where: {
        doctorId,
        outcome: InstantConsultancyOutcome.pending,
        expiresAt: { gt: new Date() },
      },
      orderBy: { offeredAt: 'asc' },
    });
    return this.withPatientsAndServices(rows);
  }

  // -- Internals ------------------------------------------------------------

  private async close(
    offer: InstantConsultancy,
    outcome: InstantConsultancyOutcome,
  ): Promise<void> {
    await this.prisma.instantConsultancy.update({ where: { id: offer.id }, data: { outcome } });
    await this.freeIfIdle(offer.doctorId);
    await this.audit.record({
      actorType: 'doctor',
      actorId: offer.doctorId,
      action: 'update',
      entityType: 'instant_offer',
      entityId: offer.id,
      consultationId: offer.consultationId,
      metadata: { outcome, attemptNumber: offer.attemptNumber },
    });
  }

  /**
   * Puts a provider back to `available_now` after an offer closes - but only
   * from `request_pending`. One who has since gone offline, paused, or answered
   * a different request must not be dragged back to their desk by a timeout on
   * something they already ignored.
   */
  private async freeIfIdle(doctorId: string): Promise<void> {
    await this.prisma.doctor.updateMany({
      where: { id: doctorId, presence: DoctorPresence.request_pending },
      data: { presence: DoctorPresence.available_now },
    });
  }

  private async requireOpenOffer(
    consultationId: string,
    doctorId: string,
  ): Promise<InstantConsultancy> {
    const offer = await this.prisma.instantConsultancy.findFirst({
      where: { consultationId, doctorId },
      orderBy: { attemptNumber: 'desc' },
    });
    if (!offer) {
      throw new AppException(
        InstantError.OFFER_NOT_FOUND,
        'You have no open request for this consultation.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (offer.outcome !== InstantConsultancyOutcome.pending) throw offerClosed();
    if (offer.expiresAt.getTime() <= Date.now()) throw offerClosed();
    return offer;
  }

  private async acceptanceWindowSeconds(): Promise<number> {
    return (
      (await this.config.get(ACCEPTANCE_WINDOW_KEY, WINDOW)) ?? DEFAULT_ACCEPTANCE_WINDOW_SECONDS
    );
  }

  private async nameOf(doctorId: string): Promise<string> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { fullName: true },
    });
    return doctor?.fullName ?? 'your provider';
  }

  /** One offer's masked patient identity and service, joined through its consultation. */
  private async withPatientAndService(offer: InstantConsultancy): Promise<OfferRecord> {
    const [record] = await this.withPatientsAndServices([offer]);
    return record;
  }

  /** Batched: the doctor's open-offers list reads every row at once. */
  private async withPatientsAndServices(offers: InstantConsultancy[]): Promise<OfferRecord[]> {
    if (offers.length === 0) return [];
    const consultations = await this.prisma.consultation.findMany({
      where: { id: { in: [...new Set(offers.map((offer) => offer.consultationId))] } },
      select: {
        id: true,
        patientId: true,
        status: true,
        patient: {
          select: { fullName: true, dateOfBirth: true, gender: true, preferredLanguage: true },
        },
        specialty: { select: { name: true } },
        concern: { select: { name: true } },
      },
    });
    const byConsultation = new Map(consultations.map((row) => [row.id, row]));
    return offers.map((offer) => {
      const consultation = byConsultation.get(offer.consultationId);
      return shape(offer, {
        patientId: consultation?.patientId ?? '',
        patientInitials: initialsOf(consultation?.patient.fullName ?? null),
        patientAge: consultation?.patient.dateOfBirth
          ? ageFrom(consultation.patient.dateOfBirth)
          : null,
        patientGender: consultation?.patient.gender ?? Gender.undisclosed,
        specialtyName: consultation?.specialty.name ?? 'a consultation',
        concernName: consultation?.concern?.name ?? null,
        preferredLanguage: consultation?.patient.preferredLanguage ?? 'en',
        paymentStatus: consultation ? paymentStatusOf(consultation.status) : 'unpaid',
      });
    });
  }
}

/**
 * A pool where nobody is at their desk must not be walked for ever. Past this
 * the patient is told nobody is available, which is the honest answer.
 */
const MAX_ROUTING_ATTEMPTS = 10;
const SWEEP_BATCH = 200;

function requestNotFound(): AppException {
  return new AppException(
    InstantError.REQUEST_NOT_FOUND,
    'That request does not exist.',
    HttpStatus.NOT_FOUND,
  );
}

function offerClosed(): AppException {
  return new AppException(
    InstantError.OFFER_CLOSED,
    'This request is no longer open. It may have timed out, or another provider may have taken it.',
    HttpStatus.CONFLICT,
  );
}

function shape(
  offer: InstantConsultancy,
  context: {
    patientId: string;
    patientInitials: string | null;
    patientAge: number | null;
    patientGender: Gender;
    specialtyName: string;
    concernName: string | null;
    preferredLanguage: string;
    paymentStatus: PaymentStatus;
  },
): OfferRecord {
  return {
    id: offer.id,
    consultationId: offer.consultationId,
    ...context,
    doctorId: offer.doctorId,
    attemptNumber: offer.attemptNumber,
    outcome: offer.outcome,
    offeredAt: offer.offeredAt,
    expiresAt: offer.expiresAt,
  };
}

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConsultationMode, DoctorPresence } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PlatformEvents } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InstantError } from './instant.errors';

/**
 * FR-10.4's seven states, and what each one means for routing.
 *
 * Only TWO of them can receive an instant request. Everything else is either
 * busy, away, or has said it wants scheduled work only - and the difference
 * between "cannot take one" and "does not want one" is the whole reason there
 * are seven rather than two.
 */
export const PRESENCE_STATES = [
  /** Signed out or away. Not bookable for instant, still bookable by slot. */
  DoctorPresence.offline,
  /** *** THE ONLY STATE THAT RECEIVES AN INSTANT REQUEST. *** */
  DoctorPresence.available_now,
  /** An offer is open with them right now. Not offered a second one. */
  DoctorPresence.request_pending,
  /** In the call. */
  DoctorPresence.in_consultation,
  /** FR-10.5: writing up. The completion gate is what actually blocks them. */
  DoctorPresence.completing_notes,
  /** Stepped away, deliberately. */
  DoctorPresence.paused,
  /** FR-10.3: bookable by slot, but takes NO instant requests. */
  DoctorPresence.scheduled_only,
] as const;

/**
 * What a provider may set for themselves.
 *
 * The other four are set BY the platform as things happen to them -
 * `request_pending` when an offer opens, `in_consultation` when the call
 * starts, `completing_notes` when it ends. A provider who could set those by
 * hand could sit in `in_consultation` for ever and never be offered anything,
 * which is not a status but a way of hiding.
 */
export const SELF_SETTABLE: DoctorPresence[] = [
  DoctorPresence.offline,
  DoctorPresence.available_now,
  DoctorPresence.paused,
  DoctorPresence.scheduled_only,
];

/** What the provider app shows, and what routing reads. */
export interface PresenceRecord {
  doctorId: string;
  presence: DoctorPresence;
  /** True only in `available_now`, and only with nothing outstanding. */
  canReceiveInstant: boolean;
  /** FR-10.5: set while documentation from an earlier consult is unfinished. */
  blockedByConsultationId: string | null;
  /** Whether this provider is allowed instant work at all (M-05 admin toggle). */
  allowInstantConsult: boolean;
}

/**
 * M-13's first half: where a provider is, right now.
 *
 * Presence lives on the DOCTOR ROW, owned by M-05 - there is no presence table
 * and no heartbeat column. A state that changed a hundred times a day would be
 * a hundred rows nobody reads twice, and the only question anyone asks is
 * "where are they now", which one column answers.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async of(doctorId: string): Promise<PresenceRecord> {
    const doctor = await this.require(doctorId);
    return shape(doctor);
  }

  /**
   * The provider moves their own status (FR-10.4).
   *
   * Setting `available_now` while documentation is outstanding is refused
   * rather than silently downgraded: FR-10.5 says no new instant request is
   * routed until the notes are finished, and a provider who set themselves
   * available and then received nothing would think the platform was broken.
   */
  async set(
    doctorId: string,
    presence: DoctorPresence,
    actor: AuthenticatedActor,
  ): Promise<PresenceRecord> {
    if (!SELF_SETTABLE.includes(presence)) {
      throw new AppException(
        InstantError.PRESENCE_NOT_SELF_SETTABLE,
        `"${presence}" is set by the platform as things happen, not by hand. You can be offline, available now, paused, or scheduled only.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const doctor = await this.require(doctorId);
    if (presence === DoctorPresence.available_now && doctor.blockedByConsultationId) {
      throw new AppException(
        InstantError.DOCUMENTATION_OUTSTANDING,
        'Finish the prescription or advice and the case summary for your last consultation before going available (FR-10.5).',
        HttpStatus.CONFLICT,
        { blockedByConsultationId: doctor.blockedByConsultationId },
      );
    }

    const updated = await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { presence },
    });
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'doctor_presence',
      entityId: doctorId,
      metadata: { from: doctor.presence, to: presence },
    });
    return shape(updated);
  }

  /**
   * Moved by the platform, not the provider. Used by routing and by M-14 as a
   * consultation moves through its states.
   *
   * No audit entry: these follow an action that is already recorded - the offer,
   * the acceptance, the call ending - and logging the shadow of each one twice
   * would bury the entries somebody actually reads.
   */
  async moveTo(doctorId: string, presence: DoctorPresence): Promise<void> {
    await this.prisma.doctor.update({ where: { id: doctorId }, data: { presence } });
  }

  /**
   * *** THE COMPLETION GATE (FR-10.5). ***
   *
   * Set by M-15 when a consultation ends with documentation outstanding, and
   * cleared when it is finished. While it is set the provider is routed no new
   * instant request, whatever their presence says.
   *
   * It holds a CONSULTATION ID rather than a boolean, so the provider can be
   * told exactly which one is holding them up - and so a stuck gate can be
   * traced to the row that stuck it.
   */
  async blockUntilDocumented(doctorId: string, consultationId: string): Promise<void> {
    await this.prisma.doctor.update({
      where: { id: doctorId },
      data: {
        blockedByConsultationId: consultationId,
        presence: DoctorPresence.completing_notes,
      },
    });
  }

  /**
   * *** FR-10.5, THE OTHER HALF. *** M-11 says the call is over and the write-up
   * is due; this shuts the gate. M-15 opens it again when the record is
   * finalised, which is the only thing that does.
   *
   * INSTANT consultations only, which is what FR-10.5 says: "after an instant
   * consultation, no new instant request is routed to that doctor until the
   * prescription or advice and the case summary are finished". A scheduled
   * consultation is written up between appointments and blocking on it would
   * take a provider off instant duty for the rest of the day.
   *
   * A subscriber rather than a call, because M-11 owns the status and must not
   * know what a presence gate is - and because a failure here must never be the
   * reason a consultation fails to end.
   */
  @OnEvent('consultation.documentation_due')
  async onDocumentationDue(event: PlatformEvents['consultation.documentation_due']): Promise<void> {
    if (event.mode !== ConsultationMode.instant) return;
    await this.blockUntilDocumented(event.doctorId, event.consultationId);
    this.logger.log(
      { doctorId: event.doctorId, consultationId: event.consultationId },
      'Instant-consult gate shut until this consultation is documented',
    );

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: event.consultationId },
      select: { patient: { select: { fullName: true } } },
    });
    await this.notifications.notify({
      code: 'pending_documentation',
      to: { doctorId: event.doctorId },
      consultationId: event.consultationId,
      variables: { patientName: consultation?.patient.fullName ?? 'a patient' },
      deepLink: { screen: 'consultation', consultationId: event.consultationId },
    });
  }

  /** Documentation is finished. The gate opens; presence does not change itself. */
  async clearCompletionGate(doctorId: string): Promise<void> {
    await this.prisma.doctor.update({
      where: { id: doctorId },
      data: { blockedByConsultationId: null },
    });
  }

  private async require(doctorId: string) {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) {
      throw new AppException(
        InstantError.DOCTOR_NOT_AVAILABLE,
        'That provider does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return doctor;
  }
}

function shape(doctor: {
  id: string;
  presence: DoctorPresence;
  blockedByConsultationId: string | null;
  allowInstantConsult: boolean;
}): PresenceRecord {
  return {
    doctorId: doctor.id,
    presence: doctor.presence,
    // Three things at once, and all three are required: available, permitted,
    // and not held by unfinished paperwork.
    canReceiveInstant:
      doctor.presence === DoctorPresence.available_now &&
      doctor.allowInstantConsult &&
      doctor.blockedByConsultationId === null,
    blockedByConsultationId: doctor.blockedByConsultationId,
    allowInstantConsult: doctor.allowInstantConsult,
  };
}

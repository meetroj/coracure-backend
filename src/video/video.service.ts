import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Consultation, ConsultationStatus, PaymentStatus } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { ConsentsService } from '../legal/consents.service';
import { LiveKitService, VideoEvent } from './livekit.service';
import { consultationIdFrom, identityFor, partyFrom, roomNameFor } from './room-name';
import { CallParty, SessionSummary, summariseSession } from './session';
import { VideoError } from './video.errors';

export const JOIN_WINDOW_KEY = 'video.join_window_minutes';
/**
 * How early a scheduled consultation may be joined. Long enough for both to
 * arrive, run the device check and be waiting when the hour comes; short enough
 * that a room is not sitting open for hours before anyone is due in it.
 */
export const DEFAULT_JOIN_WINDOW_MINUTES = 15;

/** Zero opens the room the moment it is paid for; an hour is the sensible ceiling. */
const JOIN_WINDOW = z.number().int().min(0).max(60);

/** What the client needs to connect, and nothing else. */
export interface JoinTicket {
  consultationId: string;
  roomName: string;
  /** From the environment. One deployment, one url (LiveKit_strategy 25). */
  serverUrl: string;
  token: string;
  identity: string;
  expiresInSeconds: number;
  canPublish: boolean;
  canSubscribe: boolean;
}

/** FR-8.2's pre-call check, from the backend's side: may I join, and where. */
export interface JoinReadiness {
  consultationId: string;
  serverUrl: string;
  joinable: boolean;
  /** A `VideoError` code when `joinable` is false, so the app can say why. */
  reason?: string;
  message?: string;
  /** When a scheduled consultation opens. Null for an instant one. */
  opensAt?: Date | null;
}

/** The session record, every figure of it computed (FR-8.6). */
export interface SessionRecord extends SessionSummary {
  consultationId: string;
  connections: {
    party: CallParty;
    joinedAt: Date;
    leftAt: Date | null;
    disconnectReason: string | null;
  }[];
}

/** The two parties, and the caller's own side of the consultation. */
type Joinable = { consultation: Consultation; party: CallParty };

/**
 * M-14 Video Consultation. Owns `consultation_participants`.
 *
 * *** THE MEDIA NEVER TOUCHES THIS SERVICE. *** LiveKit Server is a separate
 * process; this is the control plane (LiveKit_strategy 2). Everything here is
 * one of three things: deciding who may join, signing a token that says so, and
 * recording what LiveKit reports afterwards.
 *
 * *** ONLY THE TWO ASSIGNED PARTIES. *** That is the module's completion
 * criterion, and it is enforced in four independent places, because a video
 * room is the one place on this platform where a mistake is unrecoverable -
 * a third party in a clinical call cannot be un-heard:
 *
 *   1. here, which mints a token for the assigned patient and the assigned
 *      doctor and refuses everybody else, admins included;
 *   2. the grant itself, scoped to one room, with no `roomList` or `roomAdmin`;
 *   3. `max_participants: 2` in livekit.yaml, enforced by the media server;
 *   4. a CHECK on `consultation_participants.party`, which refuses to record
 *      anyone but a patient or a doctor having been there.
 */
@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly livekit: LiveKitService,
    private readonly consents: ConsentsService,
    private readonly booking: BookingService,
  ) {}

  // -- Joining --------------------------------------------------------------

  /**
   * FR-8.5. A short-lived token for one room, for one of its two parties.
   *
   * The order of the checks is the order in which each one tells the caller
   * something more specific. Party first, because to anybody else the
   * consultation does not exist at all; then consent, then payment, then the
   * state of the booking, then the clock.
   *
   * The token is NOT stored. It lives for minutes and cannot be revoked, so
   * there is nothing useful to keep - but the fact that one was ISSUED is an
   * audit entry, which is what answers "who was let into this call" later.
   */
  async issueJoinToken(consultationId: string, actor: AuthenticatedActor): Promise<JoinTicket> {
    const { consultation, party } = await this.requireJoinable(consultationId, actor);

    const room = roomNameFor(consultation.id);
    const identity = identityFor(party);
    const grants = grantsFor(party);
    const token = await this.livekit.issueToken({ room, identity, ...grants });

    // *** THE TOKEN IS NOT A ROW; ITS ISSUE IS. *** Not the token itself, which
    // is a bearer credential for a clinical call - writing it down would create
    // a second copy of the thing the short TTL exists to limit.
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'create',
      entityType: 'video_join_token',
      entityId: consultation.id,
      consultationId: consultation.id,
      metadata: { party, room, ...grants, ttlSeconds: this.livekit.tokenTtlSeconds },
    });

    return {
      consultationId: consultation.id,
      roomName: room,
      serverUrl: this.livekit.serverUrl,
      token,
      identity,
      expiresInSeconds: this.livekit.tokenTtlSeconds,
      ...grants,
    };
  }

  /**
   * FR-8.2's pre-call check, answered without minting anything.
   *
   * The app runs its camera, microphone and network checks before the patient
   * presses Join, and needs to know whether Join will work at all. Asking for a
   * token to find out would start a five-minute clock the device check might
   * outlive, so this answers the same question and issues nothing.
   */
  async readiness(consultationId: string, actor: AuthenticatedActor): Promise<JoinReadiness> {
    const consultation = await this.requireParty(consultationId, actor);
    const opensAt = await this.opensAt(consultation);
    try {
      await this.requireJoinable(consultationId, actor);
      return {
        consultationId: consultation.id,
        serverUrl: this.livekit.serverUrl,
        joinable: true,
        opensAt,
      };
    } catch (error) {
      if (!(error instanceof AppException)) throw error;
      const body = error.getResponse() as { code: string; message: string };
      return {
        consultationId: consultation.id,
        serverUrl: this.livekit.serverUrl,
        joinable: false,
        reason: body.code,
        message: body.message,
        opensAt,
      };
    }
  }

  // -- The session record ---------------------------------------------------

  /**
   * FR-8.6. Join and leave times, and the call duration, against the
   * consultation id - every figure computed from the connection rows and none
   * of them stored. For the two parties to the call.
   */
  async sessionFor(consultationId: string, actor: AuthenticatedActor): Promise<SessionRecord> {
    const consultation = await this.requireParty(consultationId, actor);
    return this.sessionOf(consultation.id);
  }

  /**
   * The same record, for an admin adjudicating a complaint or a refund.
   *
   * Reading a session and joining one are different powers, and an admin has
   * the first and not the second. `disconnect_reason` is the point of this: it
   * is what separates a doctor who hung up from a patient whose network died,
   * and a technical-issue complaint cannot be settled fairly without it.
   */
  async sessionForAdmin(consultationId: string, actor: AuthenticatedActor): Promise<SessionRecord> {
    assertPermission(actor, 'operations', 'clinical_governance', 'finance');
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { id: true },
    });
    if (!consultation) throw notFound();
    return this.sessionOf(consultation.id);
  }

  /** The same record, without an actor. For the modules that read it. */
  async sessionOf(consultationId: string, now = new Date()): Promise<SessionRecord> {
    const rows = await this.prisma.consultationParticipant.findMany({
      where: { consultationId },
      orderBy: { joinedAt: 'asc' },
      select: { party: true, joinedAt: true, leftAt: true, disconnectReason: true },
    });
    // The CHECK on `party` means this cast cannot be wrong: the database
    // refuses an admin or system row, so every row here is one of the two.
    const connections = rows.map((row) => ({ ...row, party: row.party as CallParty }));
    return { consultationId, connections, ...summariseSession(connections, now) };
  }

  // -- The webhook ----------------------------------------------------------

  /**
   * *** THE ONLY WRITER OF `consultation_participants`. ***
   *
   * Nothing a client sends can create, close or alter a connection row. A
   * client that could would be able to invent an attendance record, a call
   * duration and a no-show for a consultation - which is what a disputed refund
   * turns on - so the signature is checked before a single field is read.
   *
   * Every event is idempotent. LiveKit retries a webhook it did not get a 200
   * for, so a second delivery is normal traffic rather than an error.
   */
  async handleWebhook(rawBody: string, authHeader: string): Promise<{ handled: boolean }> {
    const event = await this.livekit.verifyWebhook(rawBody, authHeader);
    if (!event) {
      // Not a bad request - a forged one. The distinction matters in a log.
      throw new AppException(
        VideoError.WEBHOOK_NOT_VERIFIED,
        'Signature verification failed.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (event.kind === 'ignored') return { handled: false };

    const consultationId = consultationIdFrom(event.roomName);
    if (!consultationId) {
      // A room this module did not name. A LiveKit shared with anything else
      // delivers those, and they are not ours to record.
      this.logger.debug({ room: event.roomName }, 'Webhook for a room that is not a consultation');
      return { handled: false };
    }

    await this.audit.record({
      actorType: 'system',
      action: 'webhook',
      entityType: 'video_webhook',
      entityId: `${event.kind}:${consultationId}`,
      consultationId,
      metadata: { event: event.kind, room: event.roomName },
    });

    switch (event.kind) {
      case 'participant_joined':
        return { handled: await this.recordJoin(consultationId, event) };
      case 'participant_left':
        return { handled: await this.recordLeave(event) };
      case 'room_finished':
        return { handled: await this.closeSession(consultationId, event.at) };
      case 'participant_connection_aborted':
        return { handled: this.recordAbortedAttempt(consultationId, event) };
    }
  }

  /**
   * A connection opened.
   *
   * `create` rather than `upsert`, with the duplicate swallowed: the primary
   * key is LiveKit's per-connection SID, so a redelivery collides here and
   * MUST change nothing. An upsert would happily rewrite the join time of a
   * connection that is already recorded.
   */
  private async recordJoin(
    consultationId: string,
    event: Extract<VideoEvent, { kind: 'participant_joined' }>,
  ): Promise<boolean> {
    const party = partyFrom(event.identity);
    if (!party) {
      // Only this service mints tokens, and it only ever mints the two
      // identities. Anything else in our room means a key has leaked.
      this.logger.error(
        { consultationId, identity: event.identity },
        'A participant joined a consultation room under an identity this service never issues',
      );
      return false;
    }

    try {
      await this.prisma.consultationParticipant.create({
        data: {
          livekitParticipantSid: event.participantSid,
          consultationId,
          party,
          joinedAt: event.at,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return false;
    }

    // M-11 owns the status. This is the first connection to arrive, or a later
    // one finding it already `in_progress`, which that method absorbs.
    await this.booking.markInProgress(consultationId);
    return true;
  }

  /**
   * A party tried to join and their media connection never came up.
   *
   * *** NO ROW. *** `consultation_participants` records connections that
   * happened, and this one did not: `joined_at` is NOT NULL and means
   * "connected". Writing one would make a patient who never got in look like a
   * patient who attended, and the no-show they are entitled to would be
   * unrecordable.
   *
   * The audit entry above it is the whole point of handling the event: "I could
   * not get into the call" is otherwise unanswerable, and three aborted attempts
   * against no participant row is a network problem rather than a patient who
   * did not turn up. Almost always TURN, which is why the strategy is explicit
   * that it must be tested from a genuinely restrictive network.
   */
  private recordAbortedAttempt(
    consultationId: string,
    event: Extract<VideoEvent, { kind: 'participant_connection_aborted' }>,
  ): boolean {
    this.logger.warn(
      { consultationId, identity: event.identity, participantSid: event.participantSid },
      'A party could not establish a media connection to the consultation room',
    );
    return true;
  }

  /**
   * A connection closed.
   *
   * `updateMany` on a row that is still open, so a redelivered leave cannot
   * move a time that is already recorded, and a leave for a connection this
   * service never saw join changes nothing at all rather than inventing one.
   */
  private async recordLeave(
    event: Extract<VideoEvent, { kind: 'participant_left' }>,
  ): Promise<boolean> {
    const closed = await this.prisma.consultationParticipant.updateMany({
      where: { livekitParticipantSid: event.participantSid, leftAt: null },
      data: { leftAt: event.at, disconnectReason: event.disconnectReason },
    });
    return closed.count > 0;
  }

  /**
   * The room closed. LiveKit does that once it has been empty for its idle
   * timeout, so by definition nobody is connected any more.
   *
   * Any row still open at this point is a leave webhook that never arrived.
   * Closing it at the room's end time is the true fact - the room is gone, so
   * they are not in it - and it is what keeps a lost webhook from leaving a
   * connection that appears to run for ever. The disconnect reason stays NULL,
   * because we know WHEN they went and genuinely do not know why.
   */
  private async closeSession(consultationId: string, endedAt: Date): Promise<boolean> {
    const dangling = await this.prisma.consultationParticipant.updateMany({
      where: { consultationId, leftAt: null },
      data: { leftAt: endedAt },
    });
    if (dangling.count > 0) {
      this.logger.warn(
        { consultationId, connections: dangling.count },
        'Closed connections at room end whose participant_left webhook never arrived',
      );
    }
    await this.booking.markCallEnded(consultationId);
    return true;
  }

  // -- Authorisation --------------------------------------------------------

  /** Either party to it. To anyone else - an admin included - it does not exist. */
  private async requireParty(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Consultation> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });
    if (!consultation || !partyOf(consultation, actor)) throw notFound();
    return consultation;
  }

  /**
   * Every condition FR-8.5 puts on a join, in the order that tells the caller
   * the most useful thing first.
   */
  private async requireJoinable(
    consultationId: string,
    actor: AuthenticatedActor,
  ): Promise<Joinable> {
    const consultation = await this.requireParty(consultationId, actor);
    const party = partyOf(consultation, actor);
    // `requireParty` has already refused a non-party, so this cannot be null.
    if (!party) throw notFound();

    // SRS 6.2: consent before teleconsultation, for BOTH sides. M-03 owns the
    // rule and the current version of the document it is against.
    await this.consents.assertTeleconsultationConsent(actor);

    await this.requirePaid(consultation);
    requireJoinableStatus(consultation);
    await this.requireWithinWindow(consultation);

    return { consultation, party };
  }

  /**
   * FR-8.5: after the payment check.
   *
   * Checked on the PAYMENT row rather than inferred from the status, even
   * though the two agree today - `scheduled` is reached only through M-12's
   * webhook. They agree because of a rule in another module, and this is the
   * requirement that the money arrived, stated where it is relied on.
   */
  private async requirePaid(consultation: Consultation): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { consultationId: consultation.id },
      select: { status: true },
    });
    if (payment?.status === PaymentStatus.paid) return;
    throw new AppException(
      VideoError.NOT_PAID,
      'This consultation has not been paid for yet.',
      HttpStatus.PAYMENT_REQUIRED,
      { paymentStatus: payment?.status ?? null },
    );
  }

  /**
   * A scheduled consultation opens shortly before its start time.
   *
   * There is no closing bound to match it. Consultations overrun, and a call cut
   * off by the clock mid-sentence would be a worse failure than a room sitting
   * open a few minutes longer than booked. What closes a call is the status
   * machine and LiveKit's own idle timeout, not this.
   *
   * An instant consultation has no `scheduled_start_at` at all: it was paid for
   * in order to happen now, so there is nothing to be early for.
   */
  private async requireWithinWindow(consultation: Consultation): Promise<void> {
    const opensAt = await this.opensAt(consultation);
    if (!opensAt || opensAt <= new Date()) return;
    throw new AppException(
      VideoError.TOO_EARLY,
      'This consultation is not open to join yet.',
      HttpStatus.CONFLICT,
      { opensAt },
    );
  }

  private async opensAt(consultation: Consultation): Promise<Date | null> {
    if (!consultation.scheduledStartAt) return null;
    const minutes = await this.joinWindowMinutes();
    return new Date(consultation.scheduledStartAt.getTime() - minutes * 60_000);
  }

  private async joinWindowMinutes(): Promise<number> {
    return (await this.config.get(JOIN_WINDOW_KEY, JOIN_WINDOW)) ?? DEFAULT_JOIN_WINDOW_MINUTES;
  }
}

/**
 * *** THE PERMISSION MODEL (LiveKit_strategy 11). ***
 *
 * A consultation is a two-way clinical conversation, so both parties publish
 * and both subscribe. There is no listener-only role in this product and no
 * observer: a supervisor sitting silently in a consultation is not a feature
 * anybody asked for, and would be a consent question if it were.
 *
 * The narrowing that matters here is therefore not between the two parties -
 * it is that this function is reached by exactly two people per consultation
 * and by nobody else. An admin gets no token at all, however senior: they can
 * reassign the provider, refund the payment and read the session record, and
 * none of that requires being in the room.
 *
 * A function rather than a constant because the permission model is a mapping
 * from an application role, and the day a role appears that should not publish
 * - a supervising clinician, an interpreter - this is where it is expressed.
 */
export function grantsFor(party: CallParty): { canPublish: boolean; canSubscribe: boolean } {
  switch (party) {
    // Both speak and both listen. Written out per party rather than returned
    // flat so that the exhaustiveness check fails loudly if a third ever
    // appears, instead of quietly handing it the same rights as a clinician.
    case 'patient':
    case 'doctor':
      return { canPublish: true, canSubscribe: true };
  }
}

/** The paid, ready states. Everything else is refused, and says which it was. */
const JOINABLE: ConsultationStatus[] = [
  // Paid and waiting, whichever way it was booked: a scheduled booking reaches
  // this on M-12's webhook, and so does an instant one once a doctor accepts.
  ConsultationStatus.scheduled,
  // Somebody is already in the room. This is how the second party gets in, and
  // how either gets back in after a signal drop.
  ConsultationStatus.in_progress,
];

function requireJoinableStatus(consultation: Consultation): void {
  if (JOINABLE.includes(consultation.status)) return;
  throw new AppException(
    VideoError.NOT_JOINABLE,
    messageFor(consultation.status),
    HttpStatus.CONFLICT,
    { status: consultation.status },
  );
}

/**
 * Why the call is not open, in words the app can show as they are. The status
 * is in the details for a client that would rather phrase it itself.
 */
function messageFor(status: ConsultationStatus): string {
  switch (status) {
    case ConsultationStatus.pending_payment:
      return 'This consultation has not been paid for yet.';
    case ConsultationStatus.awaiting_doctor:
      return 'We are still finding a provider for this consultation.';
    case ConsultationStatus.awaiting_documentation:
    case ConsultationStatus.completed:
      return 'This consultation has finished.';
    case ConsultationStatus.cancelled:
      return 'This consultation was cancelled.';
    case ConsultationStatus.no_show:
      return 'This consultation was marked as a no-show.';
    case ConsultationStatus.expired:
      return 'This booking expired before it was paid for.';
    default:
      return 'This consultation cannot be joined.';
  }
}

/**
 * Which side of the consultation the caller is, or null if they are neither.
 *
 * An admin is neither, deliberately and unlike everywhere else in this codebase
 * where `requireParty` lets one through. M-14 is done when ONLY the two
 * assigned participants can join, and an exception for a sufficiently senior
 * account is not "only".
 */
function partyOf(consultation: Consultation, actor: AuthenticatedActor): CallParty | null {
  if (actor.type === 'patient' && actor.id === consultation.patientId) return 'patient';
  if (actor.type === 'doctor' && actor.id === consultation.doctorId) return 'doctor';
  return null;
}

/**
 * The same 404 for "no such consultation" and for "not yours". Telling the two
 * apart would let anyone holding a consultation id learn that it exists.
 */
function notFound(): AppException {
  return new AppException(
    VideoError.CONSULTATION_NOT_FOUND,
    'Consultation not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** P2002. The webhook redelivery this table's primary key is chosen to absorb. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

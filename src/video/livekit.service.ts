import { DisconnectReason } from '@livekit/protocol';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';

import { AppException } from '../common/errors';
import { env } from '../config/env.validation';
import { VideoError } from './video.errors';

/**
 * What a LiveKit webhook means to us, once the signature has been checked.
 *
 * A narrow union rather than LiveKit's own event object, so that everything
 * downstream - the service, and every test of it - works against four cases
 * instead of a protobuf message. `ignored` is a first-class case, not a
 * failure: LiveKit sends track and egress events this module has no use for.
 */
export type VideoEvent =
  | {
      kind: 'participant_joined';
      roomName: string;
      participantSid: string;
      identity: string;
      at: Date;
    }
  | {
      kind: 'participant_left';
      roomName: string;
      participantSid: string;
      identity: string;
      at: Date;
      disconnectReason: string | null;
    }
  | { kind: 'room_finished'; roomName: string; at: Date }
  /**
   * A party who tried to join and whose media connection never came up - a
   * restrictive network with no TURN path out, most often. LiveKit fires this
   * INSTEAD OF `participant_joined`, not before it, so there is no session to
   * record and no row to write. It is still the answer to "the patient says
   * they could not get in", which is why it is a case of its own rather than
   * one more thing swallowed by `ignored`.
   */
  | {
      kind: 'participant_connection_aborted';
      roomName: string;
      participantSid: string;
      identity: string;
      at: Date;
    }
  | { kind: 'ignored'; event: string };

export interface JoinGrant {
  room: string;
  identity: string;
  canPublish: boolean;
  canSubscribe: boolean;
}

/** `disconnect_reason` is varchar(40); LiveKit's longest today is half that. */
const REASON_MAX = 40;

/**
 * *** THE ONLY FILE THAT TOUCHES THE LIVEKIT SDK. ***
 *
 * Everything else in M-14 - the authorisation, the room naming, the session
 * arithmetic - is ours, and is tested without a LiveKit anywhere near it. This
 * is the seam: it mints tokens and it verifies webhooks, and it holds no domain
 * rules of its own. It decides nothing about WHO may join; it only signs what
 * `VideoService` has already decided.
 *
 * It carries no media and never will. LiveKit Server is a separate process
 * (LiveKit_strategy 2, 4) and the audio and video go client to client through
 * it, never through this one.
 */
@Injectable()
export class LiveKitService {
  private readonly logger = new Logger(LiveKitService.name);
  private receiver?: WebhookReceiver;

  /** From the environment, never from a row: one deployment, one url. */
  get serverUrl(): string {
    return env().LIVEKIT_URL;
  }

  /**
   * How long a token this service mints stays valid. Read here rather than by
   * the caller, so the environment is reached from one file and the figure a
   * ticket reports is necessarily the figure the token was signed with.
   */
  get tokenTtlSeconds(): number {
    return env().LIVEKIT_TOKEN_TTL_SECONDS;
  }

  /**
   * A short-lived JWT for exactly one room, as exactly one participant.
   *
   * `roomJoin` with `room` set is the narrowest grant LiveKit has: it admits
   * the holder to that ONE room and to nothing else. `roomCreate`, `roomList`
   * and `roomAdmin` are deliberately absent - a participant who could list
   * rooms could enumerate every consultation on the platform, and one who could
   * administer a room could remove the other party from it.
   *
   * `canPublish` and `canSubscribe` come from the caller rather than being
   * hardcoded true, because LiveKit_strategy 11 is explicit that not every
   * participant is handed maximum permissions.
   */
  async issueToken(grant: JoinGrant): Promise<string> {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_TOKEN_TTL_SECONDS } = env();
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw notConfigured();

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: grant.identity,
      ttl: LIVEKIT_TOKEN_TTL_SECONDS,
      // No `name` and no `metadata`. Both are handed to the OTHER participant
      // and appear in LiveKit's own logs, and neither is needed: the doctor's
      // screen gets the patient's details from this API under its own
      // authorisation (FR-8.4), so no identifying or clinical detail has any
      // reason to enter the media plane.
    });
    token.addGrant({
      roomJoin: true,
      room: grant.room,
      canPublish: grant.canPublish,
      canSubscribe: grant.canSubscribe,
      // FR-8.6: nothing is recorded. Saying so on the token means it cannot
      // start an egress even if the server were later configured for one.
      roomRecord: false,
      // The data channel carries nothing. Chat, files and notes all go through
      // this API, where they are authorised, audited and kept.
      canPublishData: false,
      // A participant who could rewrite their own metadata could change what
      // the other side is shown about them, mid-call.
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }

  /**
   * Verifies a webhook and translates it. Null means it did not verify.
   *
   * LiveKit signs with the SAME api key and secret used for tokens - there is
   * no separate webhook secret to configure. The signature is a JWT in the
   * `Authorization` header carrying a hash of the body, so verification covers
   * the bytes that were actually sent, and the SDK does the comparison.
   */
  async verifyWebhook(rawBody: string, authHeader: string): Promise<VideoEvent | null> {
    let event;
    try {
      event = await this.receiverFor().receive(rawBody, authHeader);
    } catch (error) {
      // Not a bad request - a forged one, or a clock far enough out to look
      // like one. The distinction is worth having in a log.
      this.logger.warn({ err: error }, 'Rejected a LiveKit webhook that did not verify');
      return null;
    }

    const roomName = event.room?.name;
    const participant = event.participant;
    // LiveKit's timestamps are epoch seconds, as bigints.
    const eventAt = secondsToDate(event.createdAt) ?? new Date();

    switch (event.event) {
      case 'participant_joined':
        if (!roomName || !participant?.sid) return { kind: 'ignored', event: event.event };
        return {
          kind: 'participant_joined',
          roomName,
          participantSid: participant.sid,
          identity: participant.identity,
          // The participant's OWN join time where LiveKit gives one, so a
          // webhook delayed by a retry does not push the session start later
          // than it was. The event's time is the fallback, not the first choice.
          at: msToDate(participant.joinedAtMs) ?? secondsToDate(participant.joinedAt) ?? eventAt,
        };

      case 'participant_left':
        if (!roomName || !participant?.sid) return { kind: 'ignored', event: event.event };
        return {
          kind: 'participant_left',
          roomName,
          participantSid: participant.sid,
          identity: participant.identity,
          // There is no `leftAt` on the participant, so the event's own time is
          // the leave time - which is exactly what this event means.
          at: eventAt,
          disconnectReason: reasonName(participant.disconnectReason),
        };

      case 'room_finished':
        if (!roomName) return { kind: 'ignored', event: event.event };
        return { kind: 'room_finished', roomName, at: eventAt };

      case 'participant_connection_aborted':
        if (!roomName || !participant?.sid) return { kind: 'ignored', event: event.event };
        return {
          kind: 'participant_connection_aborted',
          roomName,
          participantSid: participant.sid,
          identity: participant.identity,
          at: eventAt,
        };

      // room_started, track_*, egress_*, ingress_*. Nothing here reads them:
      // the session is made of joins and leaves, and nothing is recorded.
      default:
        return { kind: 'ignored', event: event.event };
    }
  }

  /** Built once, lazily, so a deployment with no LiveKit configured still boots. */
  private receiverFor(): WebhookReceiver {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env();
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw notConfigured();
    this.receiver ??= new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    return this.receiver;
  }
}

/**
 * LiveKit's DisconnectReason as its NAME, which is what the column stores.
 *
 * The number would be meaningless in a support query six months from now, and
 * LiveKit adds to this vocabulary between versions - which is exactly why the
 * column is a varchar rather than an enum of ours. A reason this build has
 * never heard of still lands in the row, as its number, rather than being lost.
 *
 * `UNKNOWN_REASON` becomes NULL: it is LiveKit saying it does not know, and a
 * column recording that in words says nothing that an absent value does not.
 */
function reasonName(reason: DisconnectReason | undefined): string | null {
  if (reason === undefined || reason === DisconnectReason.UNKNOWN_REASON) return null;
  return (DisconnectReason[reason] ?? String(reason)).slice(0, REASON_MAX);
}

/** LiveKit sends epoch SECONDS as a bigint. Zero means "not set". */
function secondsToDate(seconds: bigint | undefined): Date | null {
  if (seconds === undefined || seconds <= 0n) return null;
  return new Date(Number(seconds) * 1000);
}

function msToDate(milliseconds: bigint | undefined): Date | null {
  if (milliseconds === undefined || milliseconds <= 0n) return null;
  return new Date(Number(milliseconds));
}

/**
 * A 503, not a 400. The caller did nothing wrong, and retrying the same request
 * against a fixed deployment will work.
 */
function notConfigured(): AppException {
  return new AppException(
    VideoError.VIDEO_UNAVAILABLE,
    'Video consultation is not configured on this deployment.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

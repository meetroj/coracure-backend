import { ConsultationStatus, PaymentStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { ConsentsService } from '../legal/consents.service';
import { JoinGrant, LiveKitService, VideoEvent } from './livekit.service';
import { roomNameFor } from './room-name';
import { VideoError } from './video.errors';
import { VideoService } from './video.service';

type Row = Record<string, unknown>;

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ROOM = roomNameFor(ID);

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OTHER_PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-9' };
const OTHER_DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'super_admin' };

/** The error body an `AppException` carries, without reaching through `any`. */
const bodyOf = (error: unknown) =>
  (error as AppException).getResponse() as { code: string; message: string };

/** Paid, scheduled, both parties assigned - a consultation ready to be joined. */
const consultation = (over: Row = {}) => ({
  id: ID,
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  status: ConsultationStatus.scheduled,
  // Instant by default, so the join window only applies where a test sets a time.
  scheduledStartAt: null,
  ...over,
});

function build(
  over: {
    consultation?: Row | null;
    payment?: Row | null;
    participants?: Row[];
    event?: VideoEvent | null;
    createThrows?: Error;
    consentThrows?: Error;
    now?: Date;
  } = {},
) {
  const consultationFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.consultation === undefined ? consultation() : over.consultation);
  const paymentFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.payment === undefined ? { status: PaymentStatus.paid } : over.payment);

  const participantCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation(() => {
      if (over.createThrows) return Promise.reject(over.createThrows);
      return Promise.resolve({});
    });
  const participantUpdateMany = vi
    .fn<(args: { where: Row; data: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const participantFindMany = vi
    .fn<() => Promise<Row[]>>()
    .mockResolvedValue(over.participants ?? []);

  const prisma = {
    consultation: { findUnique: consultationFindUnique },
    payment: { findUnique: paymentFindUnique },
    consultationParticipant: {
      create: participantCreate,
      updateMany: participantUpdateMany,
      findMany: participantFindMany,
    },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const configGet = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(undefined);

  const issueToken = vi
    .fn<(grant: JoinGrant) => Promise<string>>()
    .mockResolvedValue('a.jwt.token');
  const verifyWebhook = vi
    .fn<() => Promise<VideoEvent | null>>()
    .mockResolvedValue(
      over.event === undefined ? { kind: 'ignored', event: 'room_started' } : over.event,
    );
  const livekit = {
    issueToken,
    verifyWebhook,
    serverUrl: 'ws://localhost:7880',
    tokenTtlSeconds: 300,
  } as unknown as LiveKitService;

  const assertTeleconsultationConsent = vi.fn<() => Promise<void>>().mockImplementation(() => {
    if (over.consentThrows) return Promise.reject(over.consentThrows);
    return Promise.resolve();
  });
  const consents = { assertTeleconsultationConsent } as unknown as ConsentsService;

  const markInProgress = vi.fn<() => Promise<Row>>().mockResolvedValue({});
  const markCallEnded = vi.fn<() => Promise<Row>>().mockResolvedValue({});
  const booking = { markInProgress, markCallEnded } as unknown as BookingService;

  return {
    service: new VideoService(
      prisma,
      { record } as unknown as AuditService,
      { get: configGet } as unknown as AppConfigService,
      livekit,
      consents,
      booking,
    ),
    issueToken,
    verifyWebhook,
    record,
    participantCreate,
    participantUpdateMany,
    markInProgress,
    markCallEnded,
    assertTeleconsultationConsent,
  };
}

/**
 * *** M-14 IS DONE WHEN ONLY THE TWO ASSIGNED PARTICIPANTS CAN JOIN. ***
 * This block is that criterion.
 */
describe('VideoService — who gets a token (FR-8.5)', () => {
  it('issues one to the assigned patient, scoped to that one room', async () => {
    const { service, issueToken } = build();
    const ticket = await service.issueJoinToken(ID, PATIENT);

    expect(ticket.token).toBe('a.jwt.token');
    expect(ticket.roomName).toBe(ROOM);
    // From the environment, never from a row: one deployment, one url.
    expect(ticket.serverUrl).toBe('ws://localhost:7880');
    expect(issueToken.mock.calls[0][0]).toEqual({
      room: ROOM,
      // The PARTY, not the account id. The consultation row says which person.
      identity: 'patient',
      canPublish: true,
      canSubscribe: true,
    });
  });

  it('issues one to the assigned doctor', async () => {
    const { service, issueToken } = build();
    const ticket = await service.issueJoinToken(ID, DOCTOR);
    expect(ticket.identity).toBe('doctor');
    expect(issueToken.mock.calls[0][0]).toMatchObject({ room: ROOM, identity: 'doctor' });
  });

  /**
   * A 404, not a 403: telling a stranger that the consultation exists but is
   * not theirs would let anyone holding an id learn that it is real.
   */
  it.each([
    ['another patient', OTHER_PATIENT],
    ['another doctor', OTHER_DOCTOR],
  ])('refuses %s, and does not admit the consultation exists', async (_case, actor) => {
    const { service, issueToken } = build();
    await expect(service.issueJoinToken(ID, actor)).rejects.toMatchObject({
      status: 404,
      response: { code: VideoError.CONSULTATION_NOT_FOUND },
    });
    expect(issueToken).not.toHaveBeenCalled();
  });

  /**
   * *** NOT EVEN A SUPER ADMIN. *** Everywhere else in this codebase an admin
   * reads through `requireParty`; a video room is the one place they do not.
   * "Only the two assigned participants" has no exception for seniority, and
   * an admin can reassign, refund and read the session record without being in
   * the room.
   */
  it('refuses an admin, however senior', async () => {
    const { service, issueToken } = build();
    await expect(service.issueJoinToken(ID, ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('refuses a consultation that does not exist', async () => {
    const { service } = build({ consultation: null });
    await expect(service.issueJoinToken(ID, PATIENT)).rejects.toMatchObject({ status: 404 });
  });

  /** An instant request that has not found a doctor has no second party yet. */
  it('refuses a doctor on a consultation with nobody assigned', async () => {
    const { service } = build({ consultation: consultation({ doctorId: null }) });
    await expect(service.issueJoinToken(ID, DOCTOR)).rejects.toMatchObject({ status: 404 });
  });
});

describe('VideoService — the conditions on a join (FR-8.5)', () => {
  it('refuses before the money arrives', async () => {
    const { service, issueToken } = build({ payment: { status: PaymentStatus.created } });
    await expect(service.issueJoinToken(ID, PATIENT)).rejects.toMatchObject({
      status: 402,
      response: { code: VideoError.NOT_PAID },
    });
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('refuses when there is no payment row at all', async () => {
    const { service } = build({ payment: null });
    await expect(service.issueJoinToken(ID, PATIENT)).rejects.toMatchObject({ status: 402 });
  });

  /** SRS 6.2: consent before teleconsultation, and M-03 owns the rule. */
  it('refuses without consent, and asks M-03 rather than deciding itself', async () => {
    const consentThrows = Object.assign(new Error('consent required'), { status: 409 });
    const { service, assertTeleconsultationConsent, issueToken } = build({ consentThrows });
    await expect(service.issueJoinToken(ID, PATIENT)).rejects.toThrow('consent required');
    expect(assertTeleconsultationConsent).toHaveBeenCalledWith(PATIENT);
    expect(issueToken).not.toHaveBeenCalled();
  });

  it.each([
    ['pending_payment', 'has not been paid'],
    ['awaiting_doctor', 'finding a provider'],
    ['awaiting_documentation', 'has finished'],
    ['completed', 'has finished'],
    ['cancelled', 'was cancelled'],
    ['no_show', 'no-show'],
    ['expired', 'expired'],
  ])('refuses a %s consultation, and says why', async (status, phrase) => {
    const { service } = build({
      consultation: consultation({ status }),
      // Paid, so it is the STATUS being refused rather than the money.
      payment: { status: PaymentStatus.paid },
    });
    const error = await service.issueJoinToken(ID, PATIENT).catch((thrown: unknown) => thrown);
    expect(bodyOf(error).code).toBe(VideoError.NOT_JOINABLE);
    // The app can show this as it stands, which is why each status has its own.
    expect(bodyOf(error).message).toContain(phrase);
  });

  /** How the second party gets in, and how either gets back after a drop. */
  it('lets a party into a call that is already in progress', async () => {
    const { service } = build({ consultation: consultation({ status: 'in_progress' }) });
    await expect(service.issueJoinToken(ID, DOCTOR)).resolves.toMatchObject({ roomName: ROOM });
  });

  it('refuses a scheduled consultation that is not open yet', async () => {
    const { service } = build({
      consultation: consultation({
        scheduledStartAt: new Date(Date.now() + 60 * 60_000),
      }),
    });
    await expect(service.issueJoinToken(ID, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: VideoError.TOO_EARLY },
    });
  });

  it('opens a scheduled consultation the configured number of minutes early', async () => {
    const { service } = build({
      // Ten minutes out, inside the fifteen-minute default.
      consultation: consultation({ scheduledStartAt: new Date(Date.now() + 10 * 60_000) }),
    });
    await expect(service.issueJoinToken(ID, PATIENT)).resolves.toMatchObject({ roomName: ROOM });
  });

  /**
   * No closing bound to match the opening one. Consultations overrun, and a
   * call cut off mid-sentence by the clock would be the worse failure.
   */
  it('does not shut a call that has run past its booked time', async () => {
    const { service } = build({
      consultation: consultation({
        status: 'in_progress',
        scheduledStartAt: new Date(Date.now() - 90 * 60_000),
      }),
    });
    await expect(service.issueJoinToken(ID, DOCTOR)).resolves.toMatchObject({ roomName: ROOM });
  });
});

describe('VideoService — the token is not stored, its issue is', () => {
  it('records who was let into the call, without writing the token down', async () => {
    const { service, record } = build();
    await service.issueJoinToken(ID, PATIENT);

    const entry = record.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: 'patient',
      actorId: 'patient-1',
      entityType: 'video_join_token',
      consultationId: ID,
      metadata: { party: 'patient', room: ROOM, canPublish: true, canSubscribe: true },
    });
    // A bearer credential for a clinical call, written into a table nobody can
    // revoke it from. The short TTL is the only control there is over it.
    expect(JSON.stringify(entry)).not.toContain('a.jwt.token');
  });

  it('mints a fresh token each time rather than reusing one', async () => {
    const { service, issueToken } = build();
    await service.issueJoinToken(ID, PATIENT);
    await service.issueJoinToken(ID, PATIENT);
    expect(issueToken).toHaveBeenCalledTimes(2);
  });
});

/** FR-8.2. The app needs to know whether Join will work before it runs its checks. */
describe('VideoService — the pre-call check', () => {
  it('says yes, and where to connect, without issuing anything', async () => {
    const { service, issueToken } = build();
    await expect(service.readiness(ID, PATIENT)).resolves.toMatchObject({
      joinable: true,
      serverUrl: 'ws://localhost:7880',
    });
    // Asking for a token to find out would start a five-minute clock the
    // device check might outlive.
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('says no and why, so the app can show it', async () => {
    const { service } = build({ payment: { status: PaymentStatus.failed } });
    await expect(service.readiness(ID, PATIENT)).resolves.toMatchObject({
      joinable: false,
      reason: VideoError.NOT_PAID,
    });
  });

  it('tells a patient who is early when the call opens', async () => {
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const { service } = build({ consultation: consultation({ scheduledStartAt: startsAt }) });
    const readiness = await service.readiness(ID, PATIENT);
    expect(readiness.joinable).toBe(false);
    expect(readiness.opensAt).toEqual(new Date(startsAt.getTime() - 15 * 60_000));
  });

  it('is still a 404 to somebody who is not a party', async () => {
    const { service } = build();
    await expect(service.readiness(ID, OTHER_PATIENT)).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * *** THE WEBHOOK IS THE ONLY WRITER OF `consultation_participants`. ***
 *
 * Nothing a client sends can create, close or alter a connection row. A client
 * that could would be able to invent an attendance record, a call duration and
 * a no-show - which is what a disputed refund turns on.
 */
describe('VideoService — the webhook (the only writer)', () => {
  const joined = (
    over: Partial<Extract<VideoEvent, { kind: 'participant_joined' }>> = {},
  ): VideoEvent => ({
    kind: 'participant_joined',
    roomName: ROOM,
    participantSid: 'PA_abc',
    identity: 'patient',
    at: new Date('2026-09-14T10:00:00.000Z'),
    ...over,
  });

  it('refuses anything that does not verify, and writes nothing', async () => {
    const { service, participantCreate } = build({ event: null });
    await expect(service.handleWebhook('{}', 'forged')).rejects.toMatchObject({
      status: 401,
      response: { code: VideoError.WEBHOOK_NOT_VERIFIED },
    });
    expect(participantCreate).not.toHaveBeenCalled();
  });

  it('records a connection and starts the consultation', async () => {
    const { service, participantCreate, markInProgress } = build({ event: joined() });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: true });

    expect(participantCreate.mock.calls[0][0].data).toEqual({
      // LiveKit's per-connection SID IS the key. That is what absorbs a retry.
      livekitParticipantSid: 'PA_abc',
      // Parsed back out of the room name - there is no stored room.
      consultationId: ID,
      party: 'patient',
      joinedAt: new Date('2026-09-14T10:00:00.000Z'),
    });
    // M-11 owns the status; M-14 only tells it the call began.
    expect(markInProgress).toHaveBeenCalledWith(ID);
  });

  /**
   * LiveKit retries any webhook it did not get a 200 for, so a second delivery
   * is normal traffic. The primary key collides and the row is left exactly as
   * it was - rather than an upsert rewriting a join time already recorded.
   */
  it('makes a redelivered join a no-op instead of a second connection', async () => {
    const { service, markInProgress } = build({
      event: joined(),
      createThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: false });
    expect(markInProgress).not.toHaveBeenCalled();
  });

  it('does not swallow a database failure that is not a redelivery', async () => {
    const { service } = build({
      event: joined(),
      createThrows: Object.assign(new Error('connection lost'), { code: 'P1001' }),
    });
    await expect(service.handleWebhook('{}', 'signed')).rejects.toThrow('connection lost');
  });

  /**
   * Only this service mints tokens and it only ever mints two identities, so
   * anything else in one of our rooms means a key has leaked. It is refused
   * rather than recorded - and the CHECK on `party` would refuse it anyway.
   */
  it('refuses a participant under an identity it never issues', async () => {
    const { service, participantCreate } = build({ event: joined({ identity: 'admin' }) });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: false });
    expect(participantCreate).not.toHaveBeenCalled();
  });

  /** A LiveKit shared with a load test or a later product delivers these. */
  it('ignores a room it did not name', async () => {
    const { service, participantCreate } = build({ event: joined({ roomName: 'lobby' }) });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: false });
    expect(participantCreate).not.toHaveBeenCalled();
  });

  it('ignores the events it has no use for', async () => {
    const { service, participantCreate } = build({
      event: { kind: 'ignored', event: 'track_published' },
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: false });
    expect(participantCreate).not.toHaveBeenCalled();
  });

  it('closes the connection that left, and keeps the reason verbatim', async () => {
    const at = new Date('2026-09-14T10:30:00.000Z');
    const { service, participantUpdateMany } = build({
      event: {
        kind: 'participant_left',
        roomName: ROOM,
        participantSid: 'PA_abc',
        identity: 'patient',
        at,
        disconnectReason: 'CLIENT_INITIATED',
      },
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: true });

    const call = participantUpdateMany.mock.calls[0][0];
    // Only a row still OPEN, so a redelivered leave cannot move a time already
    // recorded, and a leave for a connection never seen joining invents nothing.
    expect(call.where).toEqual({ livekitParticipantSid: 'PA_abc', leftAt: null });
    expect(call.data).toEqual({ leftAt: at, disconnectReason: 'CLIENT_INITIATED' });
  });

  /**
   * LiveKit closes a room once it has been empty for its idle timeout, so by
   * definition nobody is connected. A row still open here is a leave webhook
   * that never arrived, and closing it at the room's end is the true fact -
   * without it a lost webhook leaves a connection that appears to run for ever.
   */
  it('closes connections a lost leave webhook left open, and ends the call', async () => {
    const at = new Date('2026-09-14T10:35:00.000Z');
    const { service, participantUpdateMany, markCallEnded } = build({
      event: { kind: 'room_finished', roomName: ROOM, at },
    });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: true });

    const call = participantUpdateMany.mock.calls[0][0];
    expect(call.where).toEqual({ consultationId: ID, leftAt: null });
    // The time, but no reason: we know WHEN they went and genuinely do not know
    // why, and a made-up reason would be worse than an absent one.
    expect(call.data).toEqual({ leftAt: at });
    expect(markCallEnded).toHaveBeenCalledWith(ID);
  });

  it('writes the event to the audit log, against the consultation', async () => {
    const { service, record } = build({ event: joined() });
    await service.handleWebhook('{}', 'signed');
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'system',
      action: 'webhook',
      entityType: 'video_webhook',
      consultationId: ID,
    });
  });
});

describe('VideoService — the session record (FR-8.6)', () => {
  const rows = [
    {
      party: 'patient',
      joinedAt: new Date('2026-09-14T10:00:00.000Z'),
      leftAt: new Date('2026-09-14T10:28:00.000Z'),
      disconnectReason: 'CLIENT_INITIATED',
    },
    {
      party: 'doctor',
      joinedAt: new Date('2026-09-14T10:02:00.000Z'),
      leftAt: new Date('2026-09-14T10:30:00.000Z'),
      disconnectReason: 'CLIENT_INITIATED',
    },
  ];

  it('computes the whole record off the connection rows', async () => {
    const { service } = build({ participants: rows });
    const session = await service.sessionFor(ID, PATIENT);

    expect(session.consultationId).toBe(ID);
    expect(session.startedAt).toEqual(new Date('2026-09-14T10:00:00.000Z'));
    expect(session.endedAt).toEqual(new Date('2026-09-14T10:30:00.000Z'));
    // 10:02 to 10:28 - what the two of them actually shared.
    expect(session.durationSeconds).toBe(26 * 60);
    expect(session.noShowParty).toBeNull();
    expect(session.connections).toHaveLength(2);
  });

  it('is readable by the doctor as well as the patient', async () => {
    const { service } = build({ participants: rows });
    await expect(service.sessionFor(ID, DOCTOR)).resolves.toMatchObject({ consultationId: ID });
  });

  it('is not readable by anyone else', async () => {
    const { service } = build({ participants: rows });
    await expect(service.sessionFor(ID, OTHER_PATIENT)).rejects.toMatchObject({ status: 404 });
  });

  /**
   * Reading a call and joining one are different powers, and an admin has the
   * first and not the second. `disconnectReason` is the point of it: it is what
   * separates a doctor who hung up from a patient whose network died, and a
   * technical-issue complaint cannot be settled fairly without it.
   */
  it('is readable by an admin who could never join the call', async () => {
    const { service } = build({ participants: rows });
    const session = await service.sessionForAdmin(ID, ADMIN);
    expect(session.connections.map((row) => row.disconnectReason)).toContain('CLIENT_INITIATED');
    await expect(service.issueJoinToken(ID, ADMIN)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an admin whose permission level does not cover it', async () => {
    const { service } = build({ participants: rows });
    await expect(
      service.sessionForAdmin(ID, { type: 'admin', id: 'a-2', level: 'content' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * *** FOUND BY RUNNING IT. *** A bare signal connection produces this and not
 * `participant_joined`: LiveKit fires it when a party reaches the room but
 * their media connection never comes up, which in production means a network
 * with no path out and no TURN.
 */
describe('VideoService — a party who could not get in', () => {
  const aborted: VideoEvent = {
    kind: 'participant_connection_aborted',
    roomName: ROOM,
    participantSid: 'PA_aborted',
    identity: 'patient',
    at: new Date('2026-09-14T10:00:00.000Z'),
  };

  /**
   * `joined_at` is NOT NULL and means "connected". A row here would make a
   * patient who never got in look like one who attended, and the no-show they
   * are entitled to would become unrecordable.
   */
  it('writes no connection row, because no connection happened', async () => {
    const { service, participantCreate, markInProgress } = build({ event: aborted });
    await expect(service.handleWebhook('{}', 'signed')).resolves.toEqual({ handled: true });
    expect(participantCreate).not.toHaveBeenCalled();
    // The call has not started - nobody is in it.
    expect(markInProgress).not.toHaveBeenCalled();
  });

  /**
   * But it is not silence either. "I could not get into the call" is otherwise
   * unanswerable, and repeated aborts against no participant row are a network
   * problem rather than a patient who did not turn up.
   */
  it('leaves a trail against the consultation', async () => {
    const { service, record } = build({ event: aborted });
    await service.handleWebhook('{}', 'signed');
    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'video_webhook',
      consultationId: ID,
      metadata: { event: 'participant_connection_aborted' },
    });
  });
});

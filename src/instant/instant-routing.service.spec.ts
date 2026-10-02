import { ConsultationStatus, DoctorPresence, InstantConsultancyOutcome } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import {
  AssignmentRequest,
  AssignmentResult,
  AssignmentService,
} from '../booking/assignment.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PatientProfileService } from '../patients/patient-profile.service';
import { InstantRoutingService } from './instant-routing.service';
import { PresenceRecord, PresenceService } from './presence.service';

const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
type Row = Record<string, unknown>;

const ASSIGNED = (doctorId: string): AssignmentResult => ({
  assigned: true,
  doctorId,
  durationMinutes: 30,
  matchedOn: {
    specialtyId: 'psychiatry',
    language: 'hi',
    regionId: 'karnataka',
    regionRelaxed: false,
    tieBreak: 'fewest_upcoming',
    poolSize: 3,
    availableCount: 2,
    availableMinutes: 120,
    declinedCount: 0,
  },
});

const REFUSED: AssignmentResult = {
  assigned: false,
  soonestAvailableAt: null,
  reason: 'none_free_for_long_enough',
};

const offer = (over: Row = {}) => ({
  id: 'offer-1',
  consultationId: 'consult-1',
  doctorId: 'doctor-1',
  attemptNumber: 1,
  outcome: InstantConsultancyOutcome.pending,
  offeredAt: new Date('2026-09-14T09:00:00.000Z'),
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

function build(
  over: {
    consultation?: Row | null;
    previous?: Row[];
    outcomes?: AssignmentResult[];
    canReceive?: boolean[];
    foundOffer?: Row | null;
    stale?: Row[];
    updatedCount?: number;
  } = {},
) {
  const outcomes = [...(over.outcomes ?? [ASSIGNED('doctor-1')])];
  const canReceive = [...(over.canReceive ?? [])];

  const consultationFindUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(
      over.consultation === undefined
        ? {
            id: 'consult-1',
            patientId: 'patient-1',
            specialtyId: 'psychiatry',
            status: ConsultationStatus.awaiting_doctor,
            specialty: { name: 'Psychiatry' },
          }
        : over.consultation,
    );
  const consultationUpdate = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockResolvedValue({});

  const offerFindMany = vi
    .fn<(args: { where: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.previous ?? []);
  const offerFindFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.foundOffer === undefined ? offer() : over.foundOffer);
  const offerCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(offer(args.data)));
  const offerUpdate = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockResolvedValue(offer());
  const offerUpdateMany = vi
    .fn<(args: { where: Row; data: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: over.updatedCount ?? 1 });
  const doctorUpdateMany = vi
    .fn<(args: { where: Row; data: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const doctorFindUnique = vi.fn().mockResolvedValue({ fullName: 'Dr Rao' });
  const consultationFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([
    {
      id: 'consult-1',
      patientId: 'patient-1',
      patient: {
        fullName: 'Anita Sharma',
        dateOfBirth: new Date('1990-01-01'),
        gender: 'female',
        preferredLanguage: 'hi',
      },
      specialty: { name: 'Psychiatry' },
      concern: null,
    },
  ]);

  const prisma = {
    consultation: {
      findUnique: consultationFindUnique,
      update: consultationUpdate,
      findMany: consultationFindMany,
    },
    instantConsultancy: {
      findMany: offerFindMany,
      findFirst: offerFindFirst,
      create: offerCreate,
      update: offerUpdate,
      updateMany: offerUpdateMany,
    },
    doctor: { updateMany: doctorUpdateMany, findUnique: doctorFindUnique },
    $transaction: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaService;

  // The sweep reads stale offers through the same findMany.
  if (over.stale) offerFindMany.mockResolvedValue(over.stale);

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const get = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(45);

  const resolve = vi
    .fn<(request: AssignmentRequest) => Promise<AssignmentResult>>()
    .mockImplementation(() => Promise.resolve(outcomes.shift() ?? REFUSED));
  const recordDecision = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const assignment = { resolve, recordDecision } as unknown as AssignmentService;

  const presenceOf = vi
    .fn<(doctorId: string) => Promise<PresenceRecord>>()
    .mockImplementation((doctorId) =>
      Promise.resolve({
        doctorId,
        presence: DoctorPresence.available_now,
        canReceiveInstant: canReceive.length > 0 ? (canReceive.shift() ?? true) : true,
        blockedByConsultationId: null,
        allowInstantConsult: true,
      }),
    );
  const moveTo = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const presence = { of: presenceOf, moveTo } as unknown as PresenceService;

  const getOwn = vi
    .fn<() => Promise<Row>>()
    .mockResolvedValue({ preferredLanguage: 'hi', regionId: 'karnataka' });
  const profiles = { getOwn } as unknown as PatientProfileService;

  const notify = vi
    .fn<(input: { code: string; to: Record<string, string> }) => Promise<null>>()
    .mockResolvedValue(null);
  const notifications = { notify } as unknown as NotificationsService;

  return {
    service: new InstantRoutingService(
      prisma,
      { record } as unknown as AuditService,
      { get } as unknown as AppConfigService,
      assignment,
      presence,
      profiles,
      notifications,
    ),
    offerCreate,
    offerUpdate,
    offerUpdateMany,
    consultationUpdate,
    doctorUpdateMany,
    moveTo,
    resolve,
    notify,
    record,
  };
}

describe('InstantRoutingService — offering', () => {
  /** M-11 announces the request; this is what actually offers it. */
  it('makes the first offer when M-11 announces a fresh request', async () => {
    const { service, offerCreate } = build();
    await service.onInstantRequested({ consultationId: 'consult-1' });
    expect(offerCreate).toHaveBeenCalledTimes(1);
    expect(offerCreate.mock.calls[0][0].data).toMatchObject({
      consultationId: 'consult-1',
      doctorId: 'doctor-1',
    });
  });

  it('swallows a request that was cancelled before the offer could be made', async () => {
    const { service } = build({ consultation: null });
    await expect(service.onInstantRequested({ consultationId: 'consult-1' })).resolves.toBeUndefined();
  });

  it('asks M-11 who is next rather than routing by its own rule', async () => {
    // MODULES: a re-route is "chosen by M-11's assignment rules rather than by
    // a routing rule of its own".
    const { service, resolve } = build();
    await service.offerNext('consult-1');

    expect(resolve.mock.calls[0][0]).toMatchObject({
      specialtyId: 'psychiatry',
      language: 'hi',
      regionId: 'karnataka',
    });
  });

  it('*** carries the language on every offer ***, so a re-route cannot drop it', async () => {
    // FR-20.4 is a hard requirement, and a separate routing rule here would be
    // a second place for it to be forgotten at 2am.
    const { service, resolve } = build({
      previous: [offer({ doctorId: 'doctor-9', outcome: 'declined' })],
      outcomes: [ASSIGNED('doctor-2')],
    });
    await service.offerNext('consult-1');
    expect(resolve.mock.calls[0][0].language).toBe('hi');
  });

  it('never re-offers to somebody already tried, whatever they said', async () => {
    const { service, resolve } = build({
      previous: [
        offer({ attemptNumber: 2, doctorId: 'doctor-9', outcome: 'declined' }),
        offer({ attemptNumber: 1, doctorId: 'doctor-8', outcome: 'timed_out' }),
      ],
      outcomes: [ASSIGNED('doctor-2')],
    });
    await service.offerNext('consult-1');
    expect(resolve.mock.calls[0][0].excludeDoctorIds).toEqual(['doctor-9', 'doctor-8']);
  });

  it('numbers the attempts in routing order', async () => {
    const { service, offerCreate } = build({
      previous: [offer({ attemptNumber: 2 })],
      outcomes: [ASSIGNED('doctor-2')],
    });
    await service.offerNext('consult-1');
    expect(offerCreate.mock.calls[0][0].data).toMatchObject({ attemptNumber: 3 });
  });

  it('skips a provider who is not at their desk and tries the next', async () => {
    // The assignment engine knows diaries and languages; only this module knows
    // who is actually available now.
    const { service, offerCreate } = build({
      outcomes: [ASSIGNED('doctor-away'), ASSIGNED('doctor-here')],
      canReceive: [false, true],
    });
    await service.offerNext('consult-1');
    expect(offerCreate.mock.calls[0][0].data).toMatchObject({ doctorId: 'doctor-here' });
  });

  it('gives up rather than spinning when nobody is at their desk', async () => {
    const { service, offerCreate } = build({
      outcomes: Array.from({ length: 20 }, (_v, i) => ASSIGNED(`doctor-${i}`)),
      canReceive: Array.from({ length: 20 }, () => false),
    });
    expect(await service.offerNext('consult-1')).toBeNull();
    expect(offerCreate).not.toHaveBeenCalled();
  });

  it('returns null when the pool has nobody, rather than throwing', async () => {
    const { service } = build({ outcomes: [REFUSED] });
    expect(await service.offerNext('consult-1')).toBeNull();
  });

  it('refuses to offer a request that is no longer waiting', async () => {
    const { service } = build({
      consultation: {
        id: 'consult-1',
        patientId: 'patient-1',
        specialtyId: 'psychiatry',
        status: ConsultationStatus.cancelled,
      },
    });
    await expect(service.offerNext('consult-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'REQUEST_CLOSED' },
    });
  });

  it('moves the provider to request_pending and tells them (FR-16.4)', async () => {
    const { service, moveTo, notify } = build();
    await service.offerNext('consult-1');

    expect(moveTo).toHaveBeenCalledWith('doctor-1', DoctorPresence.request_pending);
    expect(notify.mock.calls[0][0]).toMatchObject({
      code: 'instant_request',
      to: { doctorId: 'doctor-1' },
    });
  });
});

describe('InstantRoutingService — accepting', () => {
  it('assigns the provider and supersedes every other open offer', async () => {
    const { service, offerUpdateMany } = build();
    await service.accept('consult-1', DOCTOR);

    // Written conditionally on the offer still being pending: two providers
    // racing to accept cannot both win.
    expect(offerUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'offer-1', outcome: InstantConsultancyOutcome.pending },
      data: { outcome: InstantConsultancyOutcome.accepted },
    });
  });

  it('*** refuses the loser of a race ***, without changing anything', async () => {
    const { service, consultationUpdate } = build({ updatedCount: 0 });
    await expect(service.accept('consult-1', DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: 'OFFER_CLOSED' },
    });
    expect(consultationUpdate).not.toHaveBeenCalled();
  });

  it('refuses an offer whose window has closed', async () => {
    const { service } = build({ foundOffer: offer({ expiresAt: new Date(Date.now() - 1000) }) });
    await expect(service.accept('consult-1', DOCTOR)).rejects.toMatchObject({
      response: { code: 'OFFER_CLOSED' },
    });
  });

  it('refuses one already declined', async () => {
    const { service } = build({ foundOffer: offer({ outcome: 'declined' }) });
    await expect(service.accept('consult-1', DOCTOR)).rejects.toMatchObject({
      response: { code: 'OFFER_CLOSED' },
    });
  });

  it('404s a provider with no offer on that request', async () => {
    const { service } = build({ foundOffer: null });
    await expect(service.accept('consult-1', DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'OFFER_NOT_FOUND' },
    });
  });
});

describe('InstantRoutingService — declining and timing out', () => {
  it('*** re-routes on a decline with no action from the patient ***', async () => {
    // This is the module's done-when.
    const { service, offerCreate } = build({ outcomes: [ASSIGNED('doctor-2')] });
    const result = await service.decline('consult-1', DOCTOR);

    expect(result.rerouted).toBe(true);
    expect(offerCreate.mock.calls[0][0].data).toMatchObject({ doctorId: 'doctor-2' });
  });

  it('reports honestly when a decline leaves nobody', async () => {
    const { service } = build({ outcomes: [REFUSED] });
    expect(await service.decline('consult-1', DOCTOR)).toEqual({ rerouted: false });
  });

  it('times out an unanswered offer and re-routes it (FR-10.6)', async () => {
    const { service, offerUpdateMany } = build({
      stale: [offer({ expiresAt: new Date(Date.now() - 1000) })],
      outcomes: [ASSIGNED('doctor-2')],
    });
    const swept = await service.expireOpenOffers();

    expect(swept).toBe(1);
    expect(offerUpdateMany.mock.calls[0][0].data).toMatchObject({
      outcome: InstantConsultancyOutcome.timed_out,
    });
  });

  it('leaves an offer alone if it was answered between the read and the write', async () => {
    const { service, doctorUpdateMany } = build({
      stale: [offer({ expiresAt: new Date(Date.now() - 1000) })],
      updatedCount: 0,
    });
    await service.expireOpenOffers();
    expect(doctorUpdateMany).not.toHaveBeenCalled();
  });

  it('only frees a provider still sitting on the offer', async () => {
    // One who has since gone offline or answered something else must not be
    // dragged back to their desk by a timeout they already ignored.
    const { service, doctorUpdateMany } = build({
      stale: [offer({ expiresAt: new Date(Date.now() - 1000) })],
      outcomes: [REFUSED],
    });
    await service.expireOpenOffers();
    expect(doctorUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'doctor-1', presence: DoctorPresence.request_pending },
      data: { presence: DoctorPresence.available_now },
    });
  });

  it('does nothing when no offer has expired', async () => {
    const { service, offerUpdateMany } = build({ stale: [] });
    expect(await service.expireOpenOffers()).toBe(0);
    expect(offerUpdateMany).not.toHaveBeenCalled();
  });
});

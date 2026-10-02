import { ConsultationStatus, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { EventBus } from '../common/event-bus';
import { AuditService } from '../audit/audit.service';
import { AllocationPolicyService } from '../catalogue/allocation-policy.service';
import { SpecialtiesService } from '../catalogue/specialties.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { ConsentsService } from '../legal/consents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PatientProfileService } from '../patients/patient-profile.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AssignmentRequest, AssignmentResult, AssignmentService } from './assignment.service';
import { BookingService } from './booking.service';

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const STRANGER: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };

const AT = new Date('2026-09-14T09:30:00.000Z');
type Row = Record<string, unknown>;

const consultation = (over: Row = {}) => ({
  id: 'consult-1',
  referenceCode: 'CC-4K2M-7QX9',
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  specialtyId: 'psychiatry',
  concernId: null,
  mode: 'scheduled',
  status: ConsultationStatus.pending_payment,
  scheduledStartAt: AT,
  durationMinutes: 30,
  holdExpiresAt: new Date('2026-09-14T09:10:00.000Z'),
  intakeAnswers: null,
  rescheduledFromConsultationId: null,
  cancelledAt: null,
  cancelledByParty: null,
  cancellationReason: null,
  feedbackRating: null,
  createdAt: new Date('2026-09-14T09:00:00.000Z'),
  ...over,
});

const ASSIGNED: Extract<AssignmentResult, { assigned: true }> = {
  assigned: true,
  doctorId: 'doctor-1',
  durationMinutes: 30,
  matchedOn: {
    specialtyId: 'psychiatry',
    language: 'hi',
    regionId: 'karnataka',
    regionRelaxed: false,
    tieBreak: 'fewest_upcoming',
    poolSize: 3,
    availableCount: 2,
    availableMinutes: 240,
    declinedCount: 0,
  },
};

function build(
  over: {
    found?: Row | null;
    rows?: Row[];
    outcome?: AssignmentResult;
    feeInr?: number;
    createThrows?: Error;
    declines?: string[];
    maxDeclines?: number;
    assertFreeThrows?: boolean;
    language?: string | null;
    /** M-14's connection rows. One party, or both, or nobody at all. */
    attended?: Row[];
  } = {},
) {
  const created = consultation();
  const create = vi.fn<(args: { data: Row }) => Promise<Row>>().mockImplementation((args) => {
    if (over.createThrows) throw over.createThrows;
    return Promise.resolve(consultation(args.data));
  });
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) =>
      Promise.resolve(consultation({ ...(over.found ?? {}), ...args.data })),
    );
  const updateMany = vi
    .fn<(args: { where: Row; data: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 2 });
  const findUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? consultation() : over.found);
  const findFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? consultation() : over.found);
  const findMany = vi
    .fn<(args: { where: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? [created]);
  const count = vi.fn<() => Promise<number>>().mockResolvedValue(0);
  const clinicalRecordFindUnique = vi.fn<() => Promise<Row | null>>().mockResolvedValue(null);

  const auditFindMany = vi
    .fn<() => Promise<{ metadata: Row }[]>>()
    .mockResolvedValue((over.declines ?? []).map((id) => ({ metadata: { declinedDoctorId: id } })));

  // M-14 owns the writes to this; no-show marking is the one read of it.
  const participantFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue(over.attended ?? []);

  const prisma = {
    consultation: { create, update, updateMany, findUnique, findFirst, findMany, count },
    clinicalRecord: { findUnique: clinicalRecordFindUnique },
    auditLog: { findMany: auditFindMany },
    doctor: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Dr Rao' }) },
    consultationParticipant: { findMany: participantFindMany },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const configGet = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(10);

  const resolve = vi
    .fn<(request: AssignmentRequest) => Promise<AssignmentResult>>()
    .mockResolvedValue(over.outcome ?? ASSIGNED);
  const recordDecision = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const assignment = { resolve, recordDecision } as unknown as AssignmentService;

  const assertFree = vi
    .fn<() => Promise<void>>()
    .mockImplementation(() =>
      over.assertFreeThrows ? Promise.reject(new Error('taken')) : Promise.resolve(),
    );
  const scheduling = { assertFree } as unknown as SchedulingService;

  const listServices = vi
    .fn<() => Promise<{ id: string; consultationFeeInr: number }[]>>()
    .mockResolvedValue([{ id: 'psychiatry', consultationFeeInr: over.feeInr ?? 800 }]);
  const specialties = { listServices } as unknown as SpecialtiesService;

  const getOwn = vi.fn<() => Promise<Row>>().mockResolvedValue({
    preferredLanguage: over.language === undefined ? 'hi' : over.language,
    regionId: 'karnataka',
  });
  const profiles = { getOwn } as unknown as PatientProfileService;

  const assertTeleconsultationConsent = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const hasCurrentConsent = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const consents = {
    assertTeleconsultationConsent,
    hasCurrentConsent,
  } as unknown as ConsentsService;

  const current = vi.fn().mockResolvedValue({
    regionRelaxable: true,
    tieBreak: 'fewest_upcoming',
    maxPatientDeclines: over.maxDeclines ?? 2,
  });
  const policy = { current } as unknown as AllocationPolicyService;

  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);
  const notifications = { notify } as unknown as NotificationsService;

  // M-11 announces that documentation is due; M-13 and M-15 act on it.
  const publish = vi.fn<(event: string, payload: Row) => void>();

  return {
    service: new BookingService(
      prisma,
      { record } as unknown as AuditService,
      { get: configGet } as unknown as AppConfigService,
      assignment,
      scheduling,
      specialties,
      profiles,
      consents,
      policy,
      notifications,
      { publish } as unknown as EventBus,
    ),
    create,
    update,
    updateMany,
    findMany,
    record,
    resolve,
    assertFree,
    assertTeleconsultationConsent,
    notify,
    participantFindMany,
    publish,
  };
}

const input = { specialtyId: 'psychiatry', startsAt: AT };

describe('BookingService — booking a slot', () => {
  it('takes a SERVICE and a time, and returns who was assigned', async () => {
    // FR-20.1: the patient cannot choose, request or be shown a choice of
    // provider. Nothing in the input names one.
    const { service, create } = build();
    const booked = await service.bookScheduled('patient-1', input, PATIENT);

    expect(create.mock.calls[0][0].data).toMatchObject({
      patientId: 'patient-1',
      doctorId: 'doctor-1',
      specialtyId: 'psychiatry',
      scheduledStartAt: AT,
      durationMinutes: 30,
    });
    expect(booked.doctorId).toBe('doctor-1');
  });

  it('captures consent before anything else (SRS 6.2)', async () => {
    const { service, assertTeleconsultationConsent, resolve } = build();
    await service.bookScheduled('patient-1', input, PATIENT);
    expect(assertTeleconsultationConsent).toHaveBeenCalledWith(PATIENT);
    expect(resolve).toHaveBeenCalled();
  });

  it('refuses without a preferred language, because FR-20.4 cannot be relaxed', async () => {
    const { service, create } = build({ language: null });
    await expect(service.bookScheduled('patient-1', input, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROFILE_INCOMPLETE' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('holds the slot rather than booking it, while there is a fee to pay', async () => {
    const { service, create } = build({ feeInr: 800 });
    const booked = await service.bookScheduled('patient-1', input, PATIENT);

    expect(create.mock.calls[0][0].data).toMatchObject({ status: 'pending_payment' });
    expect(booked.holdExpiresAt).toBeInstanceOf(Date);
  });

  it('books a FREE service outright, with no hold that could never be settled', async () => {
    // M-06 allows a zero fee deliberately. A hold on one would expire every
    // such booking, because nothing would ever pay for it.
    const { service, create } = build({ feeInr: 0 });
    await service.bookScheduled('patient-1', input, PATIENT);
    expect(create.mock.calls[0][0].data).toMatchObject({
      status: 'scheduled',
      holdExpiresAt: null,
    });
  });

  it('asks M-07 whether the slot is free BEFORE writing anything', async () => {
    const { service, assertFree, create } = build();
    await service.bookScheduled('patient-1', input, PATIENT);
    expect(assertFree).toHaveBeenCalledWith('doctor-1', AT);
    expect(assertFree.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it('turns a lost race on the unique index into a clear refusal', async () => {
    // Two requests can both pass `assertFree` before either writes. The partial
    // unique index is the last word; this is how it reads to a patient.
    const { service } = build({
      createThrows: new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
      }),
    });
    await expect(service.bookScheduled('patient-1', input, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SLOT_TAKEN' },
    });
  });

  it('refuses with the next time the pool can cover it, never a fallback (FR-20.7)', async () => {
    const soon = new Date('2026-09-15T09:00:00.000Z');
    const { service, create } = build({
      outcome: { assigned: false, soonestAvailableAt: soon, reason: 'none_free_for_long_enough' },
    });
    await expect(service.bookScheduled('patient-1', input, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'NO_PROVIDER_AVAILABLE',
        details: { soonestAvailableAt: soon.toISOString() },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('records the refusal, so demand that could not be met leaves a trace', async () => {
    const { service } = build({
      outcome: {
        assigned: false,
        soonestAvailableAt: null,
        reason: 'no_provider_speaks_the_language',
      },
    });
    await expect(service.bookScheduled('patient-1', input, PATIENT)).rejects.toThrow();
    // `recordDecision` is the assignment service's, and it is called with no
    // consultation id because none was created.
  });

  it('creates an instant request with no provider and no time', async () => {
    const { service, create } = build();
    await service.requestInstant('patient-1', { specialtyId: 'psychiatry' }, PATIENT);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ mode: 'instant', status: 'awaiting_doctor' });
    expect(data.doctorId).toBeUndefined();
    expect(data.scheduledStartAt).toBeUndefined();
  });

  /**
   * M-13 offers the request; this module only announces it exists, the same
   * way `markCallEnded` announces documentation is due rather than reaching
   * into M-13 itself.
   */
  it('announces the request so M-13 can offer it', async () => {
    const { service, publish } = build();
    const created = await service.requestInstant(
      'patient-1',
      { specialtyId: 'psychiatry' },
      PATIENT,
    );
    expect(publish).toHaveBeenCalledWith('consultation.instant_requested', {
      consultationId: created.id,
    });
  });
});

describe('BookingService — the hold (FR-6.2)', () => {
  it('clears the expiry when payment settles, so the sweep cannot take it', async () => {
    const { service, update } = build({ found: consultation({ status: 'pending_payment' }) });
    await service.confirmPayment('consult-1');
    expect(update.mock.calls[0][0].data).toEqual({ status: 'scheduled', holdExpiresAt: null });
  });

  it('is idempotent, because a gateway delivers the same webhook twice', async () => {
    const { service, update } = build({ found: consultation({ status: 'scheduled' }) });
    const result = await service.confirmPayment('consult-1');
    expect(result.status).toBe('scheduled');
    expect(update).not.toHaveBeenCalled();
  });

  it('releases an abandoned checkout as EXPIRED, not cancelled', async () => {
    // Nobody decided this. `cancelled` records who cancelled, and a CHECK
    // refuses a cancelled row with no author.
    const { service, updateMany } = build({ rows: [{ id: 'a' }, { id: 'b' }] });
    const released = await service.releaseExpiredHolds();

    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'expired',
      holdExpiresAt: null,
    });
    expect(released).toBe(2);
  });

  it('only releases rows still pending payment when the update runs', async () => {
    // Between the read and the write a payment may have landed.
    const { service, updateMany } = build({ rows: [{ id: 'a' }] });
    await service.releaseExpiredHolds();
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ status: 'pending_payment' });
  });

  it('does nothing when no hold has elapsed', async () => {
    const { service, updateMany } = build({ rows: [] });
    expect(await service.releaseExpiredHolds()).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('BookingService — declining a provider (FR-4.4)', () => {
  it('reassigns, excluding the one declined', async () => {
    const { service, resolve, update } = build({
      found: consultation({ status: 'scheduled' }),
      outcome: { ...ASSIGNED, doctorId: 'doctor-2' },
    });
    await service.declineProvider('consult-1', 'patient-1', 'I would prefer someone else.');

    expect(resolve.mock.calls[0][0]).toMatchObject({ excludeDoctorIds: ['doctor-1'] });
    expect(update.mock.calls[0][0].data).toMatchObject({ doctorId: 'doctor-2' });
  });

  it('records the decline and its reason, so a pattern is visible', async () => {
    const { service, record } = build({
      found: consultation({ status: 'scheduled' }),
      outcome: { ...ASSIGNED, doctorId: 'doctor-2' },
    });
    await service.declineProvider('consult-1', 'patient-1', 'Wanted a female provider.');

    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'consultation_decline',
      metadata: { declinedDoctorId: 'doctor-1', reason: 'Wanted a female provider.' },
    });
  });

  it('stops at the configured limit', async () => {
    const { service, update } = build({
      found: consultation({ status: 'scheduled' }),
      declines: ['doctor-7', 'doctor-8'],
      maxDeclines: 2,
    });
    await expect(service.declineProvider('consult-1', 'patient-1', 'Again')).rejects.toMatchObject({
      status: 409,
      response: { code: 'DECLINE_LIMIT_REACHED' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('counts the declines from the audit log, not from a column', async () => {
    const { service, resolve } = build({
      found: consultation({ status: 'scheduled' }),
      declines: ['doctor-7'],
      maxDeclines: 5,
      outcome: { ...ASSIGNED, doctorId: 'doctor-2' },
    });
    await service.declineProvider('consult-1', 'patient-1', 'Once more');
    expect(resolve.mock.calls[0][0]).toMatchObject({
      excludeDoctorIds: ['doctor-7', 'doctor-1'],
    });
  });

  it('still records the decline when no replacement can be found', async () => {
    const { service, record } = build({
      found: consultation({ status: 'scheduled' }),
      outcome: { assigned: false, soonestAvailableAt: null, reason: 'all_declined' },
    });
    await expect(
      service.declineProvider('consult-1', 'patient-1', 'No thanks'),
    ).rejects.toMatchObject({ response: { code: 'NO_PROVIDER_AVAILABLE' } });
    expect(record.mock.calls[0][0]).toMatchObject({ entityType: 'consultation_decline' });
  });
});

describe('BookingService — changing and closing a booking', () => {
  it('records who cancelled and why', async () => {
    const { service, update } = build({ found: consultation({ status: 'scheduled' }) });
    await service.cancel('consult-1', PATIENT, 'Something came up');

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'cancelled',
      cancelledByParty: 'patient',
      cancellationReason: 'Something came up',
      holdExpiresAt: null,
    });
  });

  it('refuses to cancel one already completed', async () => {
    const { service } = build({ found: consultation({ status: 'completed' }) });
    await expect(service.cancel('consult-1', PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'NOT_CHANGEABLE' },
    });
  });

  it('reschedules into a NEW row, assigned again from scratch', async () => {
    // Whoever was free on Tuesday may not be free on Thursday.
    const later = new Date('2026-09-16T11:00:00.000Z');
    const { service, create, update, resolve } = build({
      found: consultation({ status: 'scheduled' }),
    });
    await service.reschedule('consult-1', later, PATIENT);

    expect(resolve.mock.calls[0][0]).toMatchObject({ at: later });
    expect(create.mock.calls[0][0].data).toMatchObject({
      scheduledStartAt: later,
      rescheduledFromConsultationId: 'consult-1',
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Rescheduled',
    });
  });

  it('does not make a paid patient pay again when they move', async () => {
    const later = new Date('2026-09-16T11:00:00.000Z');
    const { service, create } = build({ found: consultation({ status: 'scheduled' }) });
    await service.reschedule('consult-1', later, PATIENT);
    expect(create.mock.calls[0][0].data).toMatchObject({ status: 'scheduled' });
  });

  it('marks a no-show', async () => {
    const { service, update } = build({ found: consultation({ status: 'scheduled' }) });
    await service.markNoShow('consult-1', DOCTOR);
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'no_show' });
  });

  /**
   * The commonest no-show there is: the doctor joins at the appointed time and
   * waits alone, so the consultation reaches `in_progress` on that one
   * connection and ends in `awaiting_documentation`. Before M-14 introduced
   * those two statuses neither was markable, which would have left this case
   * with nowhere to go.
   */
  it.each(['in_progress', 'awaiting_documentation'])(
    'marks a no-show on a call only one party joined, from %s',
    async (status) => {
      const { service, update } = build({
        found: consultation({ status }),
        attended: [{ party: 'doctor' }],
      });
      await service.markNoShow('consult-1', DOCTOR);
      expect(update.mock.calls[0][0].data).toMatchObject({ status: 'no_show' });
    },
  );

  /**
   * *** THE EVIDENCE BEATS THE CLAIM. *** Both parties have a connection row,
   * so the call happened, and no amount of marking afterwards makes it a
   * no-show. The doctor's remedy for a call that went badly is a complaint,
   * not a status that says the patient never turned up.
   */
  it('refuses a no-show when both parties connected', async () => {
    const { service, update } = build({
      found: consultation({ status: 'in_progress' }),
      attended: [{ party: 'patient' }, { party: 'doctor' }],
    });
    await expect(service.markNoShow('consult-1', DOCTOR)).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });
});

/** The two transitions a video call causes. M-14 drives them; M-11 owns them. */
describe('BookingService — the call (M-14)', () => {
  it('moves a paid booking to in progress on the first connection', async () => {
    const { service, update, record } = build({ found: consultation({ status: 'scheduled' }) });
    await service.markInProgress('consult-1');
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'in_progress' });
    expect(record.mock.calls[0][0]).toMatchObject({ actorType: 'system' });
  });

  /** The second party joining fires the same webhook, and so does a reconnect. */
  it('absorbs a second connection to a call already in progress', async () => {
    const { service, update } = build({ found: consultation({ status: 'in_progress' }) });
    await service.markInProgress('consult-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to start a call on a consultation nobody paid for', async () => {
    const { service } = build({ found: consultation({ status: 'pending_payment' }) });
    await expect(service.markInProgress('consult-1')).rejects.toMatchObject({ status: 409 });
  });

  /**
   * `awaiting_documentation`, not `completed`: the case is not closed until
   * M-15's clinical record is written. This only says the talking is over.
   */
  it('sends a finished call to documentation', async () => {
    const { service, update } = build({ found: consultation({ status: 'in_progress' }) });
    await service.markCallEnded('consult-1');
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'awaiting_documentation' });
  });

  /**
   * LiveKit closes an empty room after its idle timeout whether anybody arrived
   * or not. A consultation nobody joined is a no-show or a cancellation -
   * neither of which is documentation waiting to be written.
   */
  it('leaves a room that closed unjoined alone', async () => {
    const { service, update } = build({ found: consultation({ status: 'scheduled' }) });
    await service.markCallEnded('consult-1');
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * FR-10.5's gate is M-13's and opening it again is M-15's. This module says
   * only that the write-up is now due, and says it as an EVENT: M-11 owns the
   * status and must not know what a presence gate is.
   */
  it('announces that documentation is due, with the mode the gate needs', async () => {
    const { service, publish } = build({
      found: consultation({ status: 'in_progress', mode: 'instant' }),
    });
    await service.markCallEnded('consult-1');
    expect(publish).toHaveBeenCalledWith('consultation.documentation_due', {
      consultationId: 'consult-1',
      doctorId: 'doctor-1',
      mode: 'instant',
    });
  });

  it('announces nothing when the call did not end here', async () => {
    const { service, publish } = build({ found: consultation({ status: 'scheduled' }) });
    await service.markCallEnded('consult-1');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('BookingService — the admin override (FR-20.8)', () => {
  it('reassigns to a named provider and records the reason', async () => {
    const { service, update, record } = build({ found: consultation({ status: 'scheduled' }) });
    await service.overrideProvider('consult-1', 'doctor-5', 'Patient asked for a change.', ADMIN);

    expect(update.mock.calls[0][0].data).toEqual({ doctorId: 'doctor-5' });
    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'consultation_assignment',
      metadata: {
        override: true,
        from: 'doctor-1',
        to: 'doctor-5',
        reason: 'Patient asked for a change.',
      },
    });
  });

  it('is a no-op when the provider named is already the one assigned', async () => {
    // Otherwise the availability guard sees THIS consultation occupying the
    // slot and refuses to reassign it to the provider already on it.
    const { service, update, assertFree } = build({
      found: consultation({ status: 'scheduled', doctorId: 'doctor-1' }),
      assertFreeThrows: true,
    });
    await expect(
      service.overrideProvider('consult-1', 'doctor-1', 'Confirming', ADMIN),
    ).resolves.toMatchObject({ doctorId: 'doctor-1' });
    expect(assertFree).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('still refuses a provider who is not free for the whole slot', async () => {
    // An override is a judgement about WHO, not a licence to double-book.
    const { service, update } = build({
      found: consultation({ status: 'scheduled' }),
      assertFreeThrows: true,
    });
    await expect(
      service.overrideProvider('consult-1', 'doctor-5', 'Because', ADMIN),
    ).rejects.toMatchObject({ status: 409, response: { code: 'OVERRIDE_NOT_POSSIBLE' } });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('BookingService — who may see a consultation', () => {
  it('shows it to either party, and to an admin', async () => {
    for (const actor of [PATIENT, DOCTOR, ADMIN]) {
      const { service } = build({ found: consultation({ status: 'scheduled' }) });
      await expect(service.getForActor('consult-1', actor)).resolves.toMatchObject({
        id: 'consult-1',
      });
    }
  });

  it('does not exist for a doctor who is not on it', async () => {
    const { service } = build({ found: consultation({ status: 'scheduled' }) });
    await expect(service.getForActor('consult-1', STRANGER)).rejects.toMatchObject({
      status: 404,
      response: { code: 'CONSULTATION_NOT_FOUND' },
    });
  });

  it('lists upcoming as what still holds time, past as everything else', async () => {
    const { service, findMany } = build();
    await service.listFor(PATIENT, { upcoming: true });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ patientId: 'patient-1' });

    await service.listFor(DOCTOR, { upcoming: false });
    expect(findMany.mock.calls[1][0].where).toMatchObject({ doctorId: 'doctor-1' });
  });
});

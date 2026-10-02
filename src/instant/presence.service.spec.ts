import { ConsultationMode, DoctorPresence } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PlatformEvents } from '../common/event-bus';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PRESENCE_STATES, PresenceService, SELF_SETTABLE } from './presence.service';

const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
type Row = Record<string, unknown>;

const doctor = (over: Row = {}) => ({
  id: 'doctor-1',
  presence: DoctorPresence.offline,
  blockedByConsultationId: null,
  allowInstantConsult: true,
  ...over,
});

function build(over: { found?: Row | null } = {}) {
  const findUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? doctor() : over.found);
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(doctor({ ...(over.found ?? {}), ...args.data })));
  const consultationFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue({ patient: { fullName: 'Anita Sharma' } });
  const prisma = {
    doctor: { findUnique, update },
    consultation: { findUnique: consultationFindUnique },
  } as unknown as PrismaService;
  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);

  return {
    service: new PresenceService(
      prisma,
      { record } as unknown as AuditService,
      { notify } as unknown as NotificationsService,
    ),
    update,
    record,
    notify,
  };
}

describe('PresenceService — the seven states (FR-10.4)', () => {
  it('implements exactly the seven the SRS names', () => {
    expect(PRESENCE_STATES).toHaveLength(7);
    expect([...PRESENCE_STATES]).toEqual([
      'offline',
      'available_now',
      'request_pending',
      'in_consultation',
      'completing_notes',
      'paused',
      'scheduled_only',
    ]);
  });

  it('lets a provider set only the four that are theirs to set', async () => {
    for (const presence of SELF_SETTABLE) {
      const { service, update } = build();
      await service.set('doctor-1', presence, DOCTOR);
      expect(update.mock.calls[0][0].data).toEqual({ presence });
    }
  });

  it.each([
    DoctorPresence.request_pending,
    DoctorPresence.in_consultation,
    DoctorPresence.completing_notes,
  ])('refuses %s, which the platform sets as things happen', async (presence) => {
    // A provider who could set these by hand could sit in `in_consultation`
    // for ever and never be offered anything - a way of hiding, not a status.
    const { service, update } = build();
    await expect(service.set('doctor-1', presence, DOCTOR)).rejects.toMatchObject({
      status: 400,
      response: { code: 'PRESENCE_NOT_SELF_SETTABLE' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('records who changed a status and what it was before', async () => {
    const { service, record } = build({ found: doctor({ presence: DoctorPresence.paused }) });
    await service.set('doctor-1', DoctorPresence.available_now, DOCTOR);
    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'doctor_presence',
      metadata: { from: 'paused', to: 'available_now' },
    });
  });
});

describe('PresenceService — the completion gate (FR-10.5)', () => {
  it('*** refuses to go available while documentation is outstanding ***', async () => {
    // Refused rather than silently downgraded: a provider who set themselves
    // available and then received nothing would think we were broken.
    const { service, update } = build({
      found: doctor({ blockedByConsultationId: 'consult-9' }),
    });
    await expect(
      service.set('doctor-1', DoctorPresence.available_now, DOCTOR),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'DOCUMENTATION_OUTSTANDING',
        details: { blockedByConsultationId: 'consult-9' },
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('still lets them go offline or pause while blocked', async () => {
    // The gate stops them TAKING work, not stepping away from it.
    const { service, update } = build({ found: doctor({ blockedByConsultationId: 'consult-9' }) });
    await service.set('doctor-1', DoctorPresence.offline, DOCTOR);
    expect(update).toHaveBeenCalled();
  });

  it('names the consultation holding them up, not just a flag', async () => {
    const { service, update } = build();
    await service.blockUntilDocumented('doctor-1', 'consult-9');
    expect(update.mock.calls[0][0].data).toEqual({
      blockedByConsultationId: 'consult-9',
      presence: DoctorPresence.completing_notes,
    });
  });

  it('opens the gate without touching presence', async () => {
    // Where they go next is theirs to choose - clearing the gate is not the
    // same as deciding they are back at their desk.
    const { service, update } = build();
    await service.clearCompletionGate('doctor-1');
    expect(update.mock.calls[0][0].data).toEqual({ blockedByConsultationId: null });
  });
});

describe('PresenceService — who can be sent a request', () => {
  it('needs all three: available, permitted, and nothing outstanding', async () => {
    const { service } = build({ found: doctor({ presence: DoctorPresence.available_now }) });
    expect((await service.of('doctor-1')).canReceiveInstant).toBe(true);
  });

  it.each([
    ['not available', { presence: DoctorPresence.paused }],
    ['scheduled only (FR-10.3)', { presence: DoctorPresence.scheduled_only }],
    ['already holding an offer', { presence: DoctorPresence.request_pending }],
    [
      'not permitted instant work',
      { presence: DoctorPresence.available_now, allowInstantConsult: false },
    ],
    [
      'documentation outstanding',
      { presence: DoctorPresence.available_now, blockedByConsultationId: 'consult-9' },
    ],
  ])('refuses one who is %s', async (_case, over) => {
    const { service } = build({ found: doctor(over) });
    expect((await service.of('doctor-1')).canReceiveInstant).toBe(false);
  });

  it('*** scheduled_only stays bookable by slot ***, it only refuses instant', async () => {
    // FR-10.3. Nothing here touches verification or listing, which is what slot
    // booking reads - so a provider in this state still takes appointments.
    const { service } = build({ found: doctor({ presence: DoctorPresence.scheduled_only }) });
    const state = await service.of('doctor-1');
    expect(state.canReceiveInstant).toBe(false);
    expect(state.presence).toBe('scheduled_only');
  });
});

/**
 * *** FR-10.5, THE COMPLETION GATE. ***
 *
 * M-11 says the write-up is due, this shuts the gate, and M-15 opens it when
 * the record is finalised. Before M-15 existed `blockUntilDocumented` had no
 * caller at all, so the rule was written down and never enforced.
 */
describe('PresenceService — the completion gate', () => {
  const event = (over: Partial<Row> = {}) =>
    ({
      consultationId: 'consult-1',
      doctorId: 'doctor-1',
      mode: ConsultationMode.instant,
      ...over,
    }) as PlatformEvents['consultation.documentation_due'];

  it('shuts the gate when an instant consultation needs writing up', async () => {
    const { service, update } = build();
    await service.onDocumentationDue(event());
    expect(update.mock.calls[0][0].data).toMatchObject({
      blockedByConsultationId: 'consult-1',
      // FR-10.4's seventh state. The provider is not offline; they are writing.
      presence: DoctorPresence.completing_notes,
    });
  });

  /**
   * FR-10.5 is about instant consultations. A scheduled one is written up
   * between appointments, and blocking on it would take a provider off instant
   * duty for the rest of the day.
   */
  it('leaves a scheduled consultation alone', async () => {
    const { service, update } = build();
    await service.onDocumentationDue(event({ mode: ConsultationMode.scheduled }));
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * The gate holds a CONSULTATION ID rather than a boolean, so a provider can
   * be told which case is holding them up and a stuck gate is traceable to the
   * row that stuck it.
   */
  it('records which consultation is holding the provider', async () => {
    const { service, update } = build();
    await service.onDocumentationDue(event({ consultationId: 'consult-42' }));
    expect(update.mock.calls[0][0].data).toMatchObject({
      blockedByConsultationId: 'consult-42',
    });
  });
});

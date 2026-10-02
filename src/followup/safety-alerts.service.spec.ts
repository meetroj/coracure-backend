import { SafetyAlertType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FollowupError } from './followup.errors';
import { SafetyAlertsService } from './safety-alerts.service';
import { countMissedRunEndingYesterday } from './checkin-sweeper.service';

type Row = Record<string, unknown>;

const ALERT = 'alert-1';
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OTHER_DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const COORDINATOR: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'care_coordinator' };
const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-2', level: 'finance' };

const ACK_AT = new Date('2026-09-16T20:00:00.000Z');

const alert = (over: Row = {}) => ({
  id: ALERT,
  alertType: SafetyAlertType.red_flag,
  consultationId: 'consult-1',
  checkinResponseId: 'checkin-1',
  reason: 'Reported thoughts of self-harm on the daily check-in.',
  acknowledgedByAdminId: null,
  acknowledgedByDoctorId: null,
  acknowledgedAt: null,
  closedAt: null,
  closingNote: null,
  createdAt: new Date('2026-09-16T19:00:00.000Z'),
  consultation: { doctorId: 'doctor-1' },
  ...over,
});

function build(over: { alert?: Row | null; notifyThrows?: Error } = {}) {
  const alertCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(alert(args.data)));
  const alertFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.alert === undefined ? alert() : over.alert);
  const alertUpdate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(alert({ ...(over.alert ?? {}), ...args.data })));
  const alertFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue([over.alert === undefined ? alert() : (over.alert ?? alert())]);

  const prisma = {
    safetyAlert: {
      create: alertCreate,
      findUnique: alertFindUnique,
      update: alertUpdate,
      findMany: alertFindMany,
    },
    consultation: {
      findUnique: vi.fn<() => Promise<Row>>().mockResolvedValue({ doctorId: 'doctor-1' }),
      findMany: vi
        .fn<() => Promise<Row[]>>()
        .mockResolvedValue([
          {
            id: 'consult-1',
            patientId: 'patient-1',
            patient: { fullName: 'Anita Sharma', dateOfBirth: new Date('1990-01-01'), gender: 'female' },
          },
        ]),
    },
  } as unknown as PrismaService;

  const notify = vi.fn<(input: Row) => Promise<Row>>().mockImplementation(() => {
    if (over.notifyThrows) return Promise.reject(over.notifyThrows);
    return Promise.resolve({});
  });
  const notifyAdmins = vi.fn<(level: string, input: Row) => Promise<number>>().mockResolvedValue(1);
  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);

  return {
    service: new SafetyAlertsService(
      prisma,
      { record: audit } as unknown as AuditService,
      { notify, notifyAdmins } as unknown as NotificationsService,
    ),
    alertCreate,
    alertUpdate,
    alertFindMany,
    notify,
    notifyAdmins,
    audit,
  };
}

describe('SafetyAlertsService — raising one (FR-13.4)', () => {
  /**
   * BOTH, not either. The doctor may be with another patient, and the whole
   * point of a care coordinator is that somebody is watching when the clinician
   * cannot be.
   */
  it('tells the treating doctor and the coordinating admins', async () => {
    const { service, notify, notifyAdmins } = build();
    await service.raise({
      alertType: SafetyAlertType.red_flag,
      consultationId: 'consult-1',
      reason: 'Reported thoughts of self-harm on the daily check-in.',
      patientName: 'A. Patient',
    });

    expect(notify.mock.calls[0][0]).toMatchObject({
      code: 'red_flag_alert',
      to: { doctorId: 'doctor-1' },
    });
    // ONE call covering both levels. A super admin holds every level, so two
    // calls would send them the same alert twice.
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins.mock.calls[0][0]).toEqual(['care_coordinator', 'clinical_governance']);
  });

  /**
   * *** THE ALERT IS THE RECORD; THE NOTIFICATION IS THE POSTMAN. ***
   * A push that does not arrive is bad. An unrecorded safety finding because a
   * push failed is unforgivable — and the governance queue is what a care
   * coordinator actually works from.
   */
  it('still records the alert when delivery fails', async () => {
    const { service, alertCreate } = build({ notifyThrows: new Error('fcm down') });
    await expect(
      service.raise({ alertType: SafetyAlertType.red_flag, consultationId: 'consult-1' }),
    ).resolves.toMatchObject({ state: 'open' });
    expect(alertCreate).toHaveBeenCalled();
  });

  /**
   * The copy carries the patient's name and nothing else. A lock-screen preview
   * is read by whoever is holding the phone (FR-16.2).
   */
  it('never puts the finding itself into the notification', async () => {
    const { service, notify } = build();
    await service.raise({
      alertType: SafetyAlertType.red_flag,
      consultationId: 'consult-1',
      reason: 'Reported thoughts of self-harm on the daily check-in.',
      patientName: 'A. Patient',
    });
    const variables = notify.mock.calls[0][0].variables as Record<string, string>;
    expect(variables).toEqual({ patientName: 'A. Patient' });
    expect(JSON.stringify(notify.mock.calls[0][0])).not.toContain('self-harm');
  });

  /** A follow-up falling due is a worklist item, not something to wake anyone for. */
  it('sends nothing for a followup_due alert', async () => {
    const { service, notify, notifyAdmins, alertCreate } = build();
    await service.raise({
      alertType: SafetyAlertType.followup_due,
      consultationId: 'consult-1',
    });
    expect(alertCreate).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});

/**
 * *** OPEN, ACKNOWLEDGED AND CLOSED ARE TIMESTAMPS. ***
 * There is no status column beside them that could disagree.
 */
describe('SafetyAlertsService — working the queue', () => {
  it.each([
    ['open', {}],
    ['acknowledged', { acknowledgedAt: ACK_AT, acknowledgedByDoctorId: 'doctor-1' }],
    [
      'closed',
      {
        acknowledgedAt: ACK_AT,
        acknowledgedByDoctorId: 'doctor-1',
        closedAt: new Date('2026-09-16T21:00:00.000Z'),
      },
    ],
  ])('reads "%s" from the two timestamps alone', async (expected, timestamps) => {
    const { service } = build({ alert: alert(timestamps) });
    const listed = await service.list(COORDINATOR, { openOnly: false });
    expect(listed[0]?.state).toBe(expected);
  });

  it('records WHO took responsibility', async () => {
    const { service, alertUpdate } = build();
    const acknowledged = await service.acknowledge(ALERT, DOCTOR);
    expect(alertUpdate.mock.calls[0][0].data).toMatchObject({
      acknowledgedByDoctorId: 'doctor-1',
      acknowledgedByAdminId: null,
    });
    expect(acknowledged.acknowledgedBy).toEqual({ type: 'doctor', id: 'doctor-1' });
  });

  /** The first acknowledger is the one who actually judged it. */
  it('leaves the first acknowledger in place on a second acknowledgement', async () => {
    const { service, alertUpdate } = build({
      alert: alert({ acknowledgedAt: new Date(), acknowledgedByDoctorId: 'doctor-1' }),
    });
    await service.acknowledge(ALERT, COORDINATOR);
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  /** Nobody closes a safety alert they did not look at. */
  it('refuses to close an alert nobody acknowledged', async () => {
    const { service, alertUpdate } = build();
    await expect(service.close(ALERT, 'Called the patient.', DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: FollowupError.ALERT_NOT_ACKNOWLEDGED },
    });
    expect(alertUpdate).not.toHaveBeenCalled();
  });

  it('closes an acknowledged alert with what was done', async () => {
    const { service, alertUpdate } = build({
      alert: alert({ acknowledgedAt: new Date(), acknowledgedByDoctorId: 'doctor-1' }),
    });
    await service.close(ALERT, '  Called the patient, brought the review forward.  ', DOCTOR);
    expect(alertUpdate.mock.calls[0][0].data).toMatchObject({
      closingNote: 'Called the patient, brought the review forward.',
    });
  });
});

describe('SafetyAlertsService — who may see an alert', () => {
  it('shows a doctor only their own patients', async () => {
    const { service, alertFindMany } = build();
    await service.list(DOCTOR, {});
    expect(alertFindMany.mock.calls[0][0].where).toMatchObject({
      consultation: { doctorId: 'doctor-1' },
      closedAt: null,
    });
  });

  it('refuses a doctor another doctor’s alert', async () => {
    const { service } = build();
    await expect(service.acknowledge(ALERT, OTHER_DOCTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an admin whose level does not handle alerts', async () => {
    const { service } = build();
    await expect(service.acknowledge(ALERT, FINANCE)).rejects.toMatchObject({ status: 403 });
  });

  /**
   * A patient never sees the alert their own check-in raised. They are shown
   * emergency guidance instead (SRS 6.3) — telling somebody in crisis that they
   * have been flagged is not care.
   */
  it('never shows a patient the alert they raised', async () => {
    const { service } = build();
    await expect(service.acknowledge(ALERT, PATIENT)).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * *** ABSENCE IS THE SIGNAL. *** A missed check-in is a MISSING row, so the
 * counting is the whole of the detection.
 */
describe('counting missed check-ins', () => {
  const startsOn = new Date('2026-09-15T00:00:00.000Z');
  const answered = (...dates: string[]) => new Set(dates);

  it('counts nothing when every day was answered', () => {
    expect(
      countMissedRunEndingYesterday(
        startsOn,
        3,
        answered('2026-09-15', '2026-09-16', '2026-09-17'),
      ),
    ).toBe(0);
  });

  it('counts a run that is still going', () => {
    expect(countMissedRunEndingYesterday(startsOn, 3, answered('2026-09-15'))).toBe(2);
  });

  /**
   * The run that matters is the one STILL GOING. A patient who missed days two
   * and three but answered on days four and five has not stopped.
   */
  it('stops counting at the last day they answered', () => {
    expect(countMissedRunEndingYesterday(startsOn, 5, answered('2026-09-15', '2026-09-19'))).toBe(
      0,
    );
  });

  it('counts every day when they never started', () => {
    expect(countMissedRunEndingYesterday(startsOn, 4, answered())).toBe(4);
  });
});

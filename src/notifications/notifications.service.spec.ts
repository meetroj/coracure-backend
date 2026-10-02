import { NotificationStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from './notifications.service';
import { PushMessage, PushProvider, PushResult } from './push/push.provider';
import { NotificationTemplatesService } from './templates.service';

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'care_coordinator' };

type Row = Record<string, unknown>;

const notification = (over: Row = {}) => ({
  id: 7n,
  patientId: 'patient-1',
  doctorId: null,
  adminId: null,
  templateCode: 'booking_confirmed',
  title: 'Your consultation is confirmed',
  body: 'Your consultation with Dr Rao is confirmed for Monday at 3pm.',
  deepLinkData: null,
  consultationId: null,
  status: NotificationStatus.queued,
  sentAt: null,
  readAt: null,
  failureReason: null,
  createdAt: new Date('2026-09-14T09:00:00.000Z'),
  ...over,
});

function build(
  over: {
    push?: PushResult;
    patientToken?: string | null;
    doctorToken?: string | null;
    renderFails?: string;
    admins?: { id: string }[];
    updatedCount?: number;
    /** What the existence re-check finds when `updateMany` matched nothing. */
    existsCount?: number;
    row?: Row;
  } = {},
) {
  const created = notification(over.row ?? {});

  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...created, ...args.data }));
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...created, ...args.data }));
  const updateMany = vi
    .fn<(args: { where: Row; data: Row }) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: over.updatedCount ?? 1 });
  const findMany = vi.fn<(args: { where: Row }) => Promise<Row[]>>().mockResolvedValue([created]);
  const count = vi
    .fn<(args: { where: Row }) => Promise<number>>()
    .mockResolvedValue(over.existsCount ?? 3);

  const patientFindUnique = vi.fn().mockResolvedValue({
    pushToken: over.patientToken === undefined ? 'tok-p' : over.patientToken,
  });
  const doctorFindUnique = vi
    .fn()
    .mockResolvedValue({ pushToken: over.doctorToken === undefined ? 'tok-d' : over.doctorToken });
  const patientUpdate = vi.fn().mockResolvedValue({});
  const doctorUpdate = vi.fn().mockResolvedValue({});
  const adminFindMany = vi.fn().mockResolvedValue(over.admins ?? []);

  const prisma = {
    notification: { create, update, updateMany, findMany, count },
    patient: { findUnique: patientFindUnique, update: patientUpdate },
    doctor: { findUnique: doctorFindUnique, update: doctorUpdate },
    admin: { findMany: adminFindMany },
  } as unknown as PrismaService;

  const render = vi
    .fn<(code: string, vars: Record<string, string>) => Promise<{ title: string; body: string }>>()
    .mockImplementation(() =>
      over.renderFails
        ? Promise.reject(new Error(over.renderFails))
        : Promise.resolve({ title: created.title, body: created.body }),
    );
  const templates = { render } as unknown as NotificationTemplatesService;

  const send = vi
    .fn<(message: PushMessage) => Promise<PushResult>>()
    .mockResolvedValue(over.push ?? { delivered: true });
  const push: PushProvider = { send };

  return {
    service: new NotificationsService(prisma, templates, push),
    create,
    update,
    updateMany,
    findMany,
    count,
    send,
    patientUpdate,
    doctorUpdate,
    adminFindMany,
  };
}

describe('NotificationsService', () => {
  // -- Raising --------------------------------------------------------------

  it('writes the row and pushes to the recipient’s current device', async () => {
    const { service, create, send } = build();
    const raised = await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      variables: { doctorName: 'Dr Rao', consultationTime: 'Monday at 3pm' },
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      patientId: 'patient-1',
      templateCode: 'booking_confirmed',
    });
    expect(send.mock.calls[0][0]).toMatchObject({ audience: 'patient', token: 'tok-p' });
    expect(raised?.status).toBe(NotificationStatus.sent);
  });

  it('returns the id as a string, because the column is a bigint', async () => {
    // JSON has no bigint. Serialising the row as it comes back would throw at
    // the response boundary, long after anything useful could be done about it.
    const { service } = build();
    const raised = await service.notify({ code: 'doctor_approved', to: { doctorId: 'doctor-1' } });
    expect(raised?.id).toBe('7');
  });

  it('carries the deep link and the consultation into the push payload as strings', async () => {
    // FCM data payloads hold strings and nothing else.
    const { service, send } = build({ row: { deepLinkData: { screen: 'booking', tab: 2 } } });
    await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      consultationId: 'consult-1',
      deepLink: { screen: 'booking', tab: '2' },
    });
    expect(send.mock.calls[0][0].data).toMatchObject({
      templateCode: 'booking_confirmed',
      notificationId: '7',
      screen: 'booking',
      tab: '2',
    });
  });

  // -- Never breaking the caller --------------------------------------------

  it('returns null rather than throwing when the copy cannot be rendered', async () => {
    // A booking is not undone because a reminder could not be worded.
    const { service, create } = build({ renderFails: 'missing variable' });
    await expect(
      service.notify({ code: 'booking_confirmed', to: { patientId: 'patient-1' } }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a template addressed to the wrong kind of account', async () => {
    // `pending_documentation` reaching a patient would tell them their provider
    // is behind on paperwork.
    const { service, create } = build();
    await expect(
      service.notify({ code: 'pending_documentation', to: { patientId: 'patient-1' } }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a code declared for two audiences to reach either', async () => {
    const { service } = build({ admins: [] });
    await expect(
      service.notify({
        code: 'red_flag_alert',
        to: { doctorId: 'doctor-1' },
        variables: { patientName: 'A' },
      }),
    ).resolves.not.toBeNull();
    await expect(
      service.notify({
        code: 'red_flag_alert',
        to: { adminId: 'admin-1' },
        variables: { patientName: 'A' },
      }),
    ).resolves.not.toBeNull();
  });

  // -- Delivery outcomes ----------------------------------------------------

  it('does not push to an admin, and still counts the row as delivered', async () => {
    // An admin has no push token by design; the panel read IS the delivery.
    // Left queued, these would pile up as a backlog nothing drains.
    const { service, send, update } = build({ row: { patientId: null, adminId: 'admin-1' } });
    await service.notify({
      code: 'red_flag_alert',
      to: { adminId: 'admin-1' },
      variables: { patientName: 'A' },
    });
    expect(send).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data).toMatchObject({ status: NotificationStatus.sent });
  });

  it('treats a recipient with no device as delivered, not failed', async () => {
    // They will see it in the app. `failed` would claim it never reached them.
    const { service, send, update } = build({ patientToken: null });
    await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      variables: { doctorName: 'Dr Rao', consultationTime: 'Monday' },
    });
    expect(send).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data).toMatchObject({ status: NotificationStatus.sent });
  });

  it('records a rejected push as failed, with the reason', async () => {
    const { service, update } = build({
      push: { delivered: false, reason: 'messaging/server-unavailable', tokenIsDead: false },
    });
    const raised = await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      variables: { doctorName: 'Dr Rao', consultationTime: 'Monday' },
    });

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: NotificationStatus.failed,
      sentAt: null,
      failureReason: 'messaging/server-unavailable',
    });
    // The row still stands, which is why a failed push is not a lost notification.
    expect(raised).not.toBeNull();
  });

  it('clears a token Firebase says is finished', async () => {
    // Otherwise the platform pushes into the void for as long as the row lives,
    // and a handset that changed hands keeps getting someone else's alerts.
    const { service, patientUpdate } = build({
      push: {
        delivered: false,
        reason: 'messaging/registration-token-not-registered',
        tokenIsDead: true,
      },
    });
    await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      variables: { doctorName: 'Dr Rao', consultationTime: 'Monday' },
    });
    expect(patientUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'patient-1' },
      data: { pushToken: null },
    });
  });

  it('leaves a live token alone when a send merely failed', async () => {
    const { service, patientUpdate } = build({
      push: { delivered: false, reason: 'push timed out', tokenIsDead: false },
    });
    await service.notify({
      code: 'booking_confirmed',
      to: { patientId: 'patient-1' },
      variables: { doctorName: 'Dr Rao', consultationTime: 'Monday' },
    });
    expect(patientUpdate).not.toHaveBeenCalled();
  });

  // -- Admin fan-out --------------------------------------------------------

  it('raises an alert for every active admin holding the responsible level', async () => {
    // Addressing a named admin would mean the alert going quiet the day they leave.
    const { service, adminFindMany, create } = build({
      admins: [{ id: 'admin-1' }, { id: 'admin-2' }],
      row: { patientId: null, adminId: 'admin-1' },
    });
    const raised = await service.notifyAdmins('care_coordinator', {
      code: 'red_flag_alert',
      variables: { patientName: 'A' },
    });

    expect(adminFindMany.mock.calls[0][0]).toMatchObject({
      where: { permissionLevel: { in: ['care_coordinator', 'super_admin'] }, status: 'active' },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(raised).toBe(2);
  });

  /**
   * *** SUPER ADMINS ARE INCLUDED IN EVERY LEVEL. ***
   *
   * `assertPermission` already treats super admin as passing everything, and an
   * exact-match filter here contradicted it: a super admin could open the safety
   * queue and was never told there was anything in it. It bites hardest on a NEW
   * deployment, where super admin is the only level that exists — M-16's
   * red-flag alerts reached the treating doctor and nobody else, silently.
   */
  it('includes super admins when addressing any other level', async () => {
    const { service, adminFindMany } = build({ admins: [{ id: 'admin-1' }] });
    await service.notifyAdmins('clinical_governance', {
      code: 'red_flag_alert',
      variables: { patientName: 'A' },
    });
    expect(adminFindMany.mock.calls[0][0]).toMatchObject({
      where: { permissionLevel: { in: ['clinical_governance', 'super_admin'] } },
    });
  });

  /** Addressing super admins themselves must not list them twice. */
  it('does not duplicate super admins when they are the level asked for', async () => {
    const { service, adminFindMany } = build({ admins: [{ id: 'admin-1' }] });
    await service.notifyAdmins('super_admin', {
      code: 'red_flag_alert',
      variables: { patientName: 'A' },
    });
    expect(adminFindMany.mock.calls[0][0]).toMatchObject({
      where: { permissionLevel: { in: ['super_admin'] } },
    });
  });

  /**
   * Several levels in ONE call. An alert addressed to both the care
   * coordinators and clinical governance is ONE alert - two calls would send a
   * super admin, who is in both, the same notification twice.
   */
  it('addresses several levels at once without repeating anybody', async () => {
    const { service, adminFindMany, create } = build({ admins: [{ id: 'admin-1' }] });
    await service.notifyAdmins(['care_coordinator', 'clinical_governance'], {
      code: 'red_flag_alert',
      variables: { patientName: 'A' },
    });
    expect(adminFindMany.mock.calls[0][0]).toMatchObject({
      where: {
        permissionLevel: { in: ['care_coordinator', 'clinical_governance', 'super_admin'] },
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  // -- Reading --------------------------------------------------------------

  it('scopes the inbox to the caller’s own column', async () => {
    const { service, findMany } = build();
    await service.inboxFor(PATIENT);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ patientId: 'patient-1' });

    await service.inboxFor(DOCTOR);
    expect(findMany.mock.calls[1][0].where).toMatchObject({ doctorId: 'doctor-1' });

    await service.inboxFor(ADMIN);
    expect(findMany.mock.calls[2][0].where).toMatchObject({ adminId: 'admin-1' });
  });

  it('keeps failed deliveries out of the inbox', async () => {
    // A push that did not land is an operations problem; the reader has the
    // copy in the app either way, and a broken row is not theirs to look at.
    const { service, findMany } = build();
    await service.inboxFor(PATIENT);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: { not: NotificationStatus.failed },
    });
  });

  it('caps how many rows one call can ask for', async () => {
    const { service, findMany } = build();
    await service.inboxFor(PATIENT, { limit: 5000 });
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 100 });
  });

  it('marks one read, scoped to the caller', async () => {
    const { service, updateMany } = build();
    await service.markRead(PATIENT, '7');
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ id: 7n, patientId: 'patient-1' });
  });

  it('404s an id belonging to somebody else rather than confirming it exists', async () => {
    const { service } = build({ updatedCount: 0, existsCount: 0 });
    await expect(service.markRead(PATIENT, '7')).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOTIFICATION_NOT_FOUND' },
    });
  });

  it('does not fail when one already read is marked again', async () => {
    // Two devices, or a double tap. Nothing changed, and that is not an error.
    const { service } = build({ updatedCount: 0, existsCount: 1 });
    await expect(service.markRead(PATIENT, '7')).resolves.toBeUndefined();
  });

  it('404s an id that is not a number at all', async () => {
    const { service } = build();
    await expect(service.markRead(PATIENT, 'not-an-id')).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOTIFICATION_NOT_FOUND' },
    });
  });

  it('counts only unread, undelivered rows excluded', async () => {
    const { service, count } = build();
    expect(await service.unreadCountFor(PATIENT)).toEqual({ unread: 3 });
    expect(count.mock.calls[0][0].where).toMatchObject({
      patientId: 'patient-1',
      readAt: null,
      status: { not: NotificationStatus.failed },
    });
  });
});

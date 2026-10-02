import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConsultationAccess, ConsultationContext } from './consultation-access';
import { ReportRequestsService } from './report-requests.service';

const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OTHER_DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };

type Row = Record<string, unknown>;

const request = (over: Row = {}) => ({
  id: 'request-1',
  consultationId: 'consult-1',
  title: 'A recent thyroid profile',
  category: 'lab',
  reason: 'To check whether the symptoms have another cause.',
  status: 'open',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  files: [],
  ...over,
});

const consultation = (over: Partial<ConsultationContext> = {}): ConsultationContext => ({
  id: 'consult-1',
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  isCompleted: false,
  ...over,
});

function build(
  over: { found?: Row | null; rows?: Row[]; context?: ConsultationContext | null } = {},
) {
  const findUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? request() : over.found);
  const findMany = vi
    .fn<(args: { where: Row }) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? [request()]);
  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(request(args.data)));
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(request(args.data)));

  const doctorFindUnique = vi.fn().mockResolvedValue({ fullName: 'Dr Meera Iyer' });
  const prisma = {
    reportRequest: { findUnique, findMany, create, update },
    doctor: { findUnique: doctorFindUnique },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);
  const contextOf = vi
    .fn<(id: string) => Promise<ConsultationContext | null>>()
    .mockResolvedValue(over.context === undefined ? consultation() : over.context);
  const consultations = { contextOf, isTreating: vi.fn() } as ConsultationAccess;

  return {
    service: new ReportRequestsService(
      prisma,
      { record } as unknown as AuditService,
      { notify } as unknown as NotificationsService,
      consultations,
    ),
    findMany,
    create,
    update,
    record,
    notify,
  };
}

describe('ReportRequestsService', () => {
  // -- Raising --------------------------------------------------------------

  it('lets the treating doctor ask for a document, naming what and why', async () => {
    const { service, create } = build();
    const raised = await service.raise(
      {
        consultationId: 'consult-1',
        title: 'A recent thyroid profile',
        category: 'lab',
        reason: 'To rule out a cause.',
      },
      DOCTOR,
    );

    expect(create.mock.calls[0][0].data).toMatchObject({
      consultationId: 'consult-1',
      title: 'A recent thyroid profile',
    });
    expect(raised.status).toBe('open');
    // The row carries no patient and no doctor: both are read through the
    // consultation, so there is no second copy to disagree with the booking.
    expect(create.mock.calls[0][0].data).not.toHaveProperty('patientId');
    expect(create.mock.calls[0][0].data).not.toHaveProperty('doctorId');
  });

  it('refuses a doctor who is not on that consultation', async () => {
    const { service, create } = build();
    await expect(
      service.raise(
        { consultationId: 'consult-1', title: 'Anything', category: 'other' },
        OTHER_DOCTOR,
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: 'CONSULTATION_NOT_FOUND' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses when the consultation cannot be resolved at all', async () => {
    // Which is every consultation until M-11 lands, and correctly so: without
    // consultations there is nothing to raise a request against.
    const { service } = build({ context: null });
    await expect(
      service.raise(
        { consultationId: 'consult-1', title: 'Anything', category: 'other' },
        DOCTOR,
      ),
    ).rejects.toMatchObject({ response: { code: 'CONSULTATION_NOT_FOUND' } });
  });

  it('drops an empty reason rather than storing a blank string', async () => {
    const { service, create } = build();
    await service.raise(
      { consultationId: 'consult-1', title: 'X', category: 'other', reason: '   ' },
      DOCTOR,
    );
    expect(create.mock.calls[0][0].data).toMatchObject({ reason: null });
  });

  // -- Reading --------------------------------------------------------------

  it('shows both parties the same list, from two sides', async () => {
    const forDoctor = build();
    const forPatient = build();
    expect(await forDoctor.service.listForConsultation('consult-1', DOCTOR)).toHaveLength(1);
    expect(await forPatient.service.listForConsultation('consult-1', PATIENT)).toHaveLength(1);
  });

  it('refuses anyone who is not a party to the consultation', async () => {
    const { service } = build();
    await expect(service.listForConsultation('consult-1', OTHER_DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'CONSULTATION_NOT_FOUND' },
    });
  });

  it('reports what came back against each request', async () => {
    const { service } = build({
      rows: [
        request({
          status: 'fulfilled',
          files: [{ id: 'file-1', fileName: 'thyroid.pdf', createdAt: new Date() }],
        }),
      ],
    });
    const [entry] = await service.listForConsultation('consult-1', DOCTOR);
    expect(entry.fulfilledBy.map((f) => f.fileName)).toEqual(['thyroid.pdf']);
  });

  it('gathers a patient’s open requests across all their consultations', async () => {
    // A patient with two bookings should not have to look in both to find out
    // what was asked of them.
    const { service, findMany } = build();
    const open = await service.openForPatient('patient-1');
    expect(findMany.mock.calls[0][0].where).toMatchObject({ status: 'open' });
    expect(open).toHaveLength(1);
  });

  it('leaves out requests belonging to another patient', async () => {
    const { service } = build({ context: consultation({ patientId: 'patient-2' }) });
    expect(await service.openForPatient('patient-1')).toEqual([]);
  });

  // -- Cancelling -----------------------------------------------------------

  it('lets the doctor withdraw a request they no longer need', async () => {
    const { service, update } = build();
    await service.cancel('request-1', DOCTOR);
    expect(update.mock.calls[0][0].data).toEqual({ status: 'cancelled' });
  });

  it('refuses to cancel one the patient has already answered', async () => {
    // It is a record of what was asked and what arrived; cancelling it
    // afterwards would rewrite that.
    const { service, update } = build({ found: request({ status: 'fulfilled' }) });
    await expect(service.cancel('request-1', DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: 'REPORT_REQUEST_CLOSED' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a doctor cancelling another doctor’s request', async () => {
    const { service } = build();
    await expect(service.cancel('request-1', OTHER_DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'REPORT_REQUEST_NOT_FOUND' },
    });
  });
});

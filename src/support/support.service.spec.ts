import { ComplaintCategory, ComplaintStatus, ConsultationStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { SupportError } from './support.errors';
import { SupportService } from './support.service';

type Row = Record<string, unknown>;

const CONSULT = 'consult-1';
const COMPLAINT = 'complaint-1';
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const OTHER_PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-9' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OPERATIONS: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'operations' };
const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-2', level: 'finance' };

const consultation = (over: Row = {}) => ({
  id: CONSULT,
  referenceCode: 'CC-4K2M-7QX9',
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  status: ConsultationStatus.completed,
  feedbackRating: null,
  feedbackComment: null,
  scheduledStartAt: new Date('2026-09-18T09:00:00.000Z'),
  ...over,
});

const complaint = (over: Row = {}) => ({
  id: COMPLAINT,
  referenceCode: 'CX-4K2M-7QX9',
  patientId: 'patient-1',
  consultationId: CONSULT,
  category: ComplaintCategory.consultation_quality,
  subject: 'The provider joined late',
  description: 'Twenty minutes late and the call was rushed.',
  status: ComplaintStatus.open,
  assignedToAdminId: null,
  messages: [],
  resolvedAt: null,
  resolutionNote: null,
  createdAt: new Date('2026-09-19T09:00:00.000Z'),
  updatedAt: new Date('2026-09-19T09:00:00.000Z'),
  ...over,
});

function build(over: { consultation?: Row | null; complaint?: Row | null; rows?: Row[] } = {}) {
  const current = over.complaint === undefined ? complaint() : over.complaint;

  const consultationFindFirst = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.consultation === undefined ? consultation() : over.consultation);
  const consultationUpdate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(consultation(args.data)));
  const consultationFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(over.rows ?? []);

  const complaintCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(complaint(args.data)));
  const complaintUpdate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(complaint({ ...(current ?? {}), ...args.data })));
  const complaintFindUnique = vi.fn<() => Promise<Row | null>>().mockResolvedValue(current);
  const complaintFindFirst = vi.fn<() => Promise<Row | null>>().mockResolvedValue(current);
  const complaintFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(current ? [current] : []);

  const executeRaw = vi.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(1);

  const prisma = {
    consultation: {
      findFirst: consultationFindFirst,
      update: consultationUpdate,
      findMany: consultationFindMany,
    },
    complaint: {
      create: complaintCreate,
      update: complaintUpdate,
      findUnique: complaintFindUnique,
      findFirst: complaintFindFirst,
      findMany: complaintFindMany,
    },
    $executeRaw: executeRaw,
  } as unknown as PrismaService;

  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);

  return {
    service: new SupportService(prisma, { record: audit } as unknown as AuditService),
    consultationUpdate,
    consultationFindMany,
    complaintCreate,
    complaintUpdate,
    complaintFindMany,
    executeRaw,
    audit,
  };
}

describe('SupportService — feedback (FR-17.1)', () => {
  it('records a rating and a comment', async () => {
    const { service, consultationUpdate } = build();
    await service.submitFeedback(CONSULT, { rating: 4, comment: '  Helpful.  ' }, PATIENT);
    expect(consultationUpdate.mock.calls[0][0].data).toEqual({
      feedbackRating: 4,
      feedbackComment: 'Helpful.',
    });
  });

  /**
   * FR-18.6 reads these as evidence about a NAMED CLINICIAN, so what goes into
   * them matters more than making the button always work.
   */
  it.each(['pending_payment', 'scheduled', 'cancelled', 'no_show', 'expired'])(
    'refuses to rate a %s consultation',
    async (status) => {
      const { service, consultationUpdate } = build({ consultation: consultation({ status }) });
      await expect(service.submitFeedback(CONSULT, { rating: 5 }, PATIENT)).rejects.toMatchObject({
        status: 409,
        response: { code: SupportError.NOT_RATEABLE },
      });
      expect(consultationUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'awaiting_documentation', 'completed'])(
    'accepts a rating on a %s consultation',
    async (status) => {
      const { service, consultationUpdate } = build({ consultation: consultation({ status }) });
      await service.submitFeedback(CONSULT, { rating: 3 }, PATIENT);
      expect(consultationUpdate).toHaveBeenCalled();
    },
  );

  it('refuses somebody else’s consultation', async () => {
    const { service } = build({ consultation: null });
    await expect(
      service.submitFeedback(CONSULT, { rating: 5 }, OTHER_PATIENT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a doctor rating their own consultation', async () => {
    const { service } = build();
    await expect(service.submitFeedback(CONSULT, { rating: 5 }, DOCTOR)).rejects.toMatchObject({
      status: 404,
    });
  });

  /**
   * The rating goes into the trail; the comment does not. The comment is the
   * patient's own words about a named clinician, and the audit log is read by
   * more people than the feedback screen is.
   */
  it('audits the rating without copying the comment', async () => {
    const { service, audit } = build();
    await service.submitFeedback(CONSULT, { rating: 2, comment: 'He was dismissive.' }, PATIENT);
    const entry = audit.mock.calls[0][0];
    expect(entry).toMatchObject({ entityType: 'consultation_feedback', metadata: { rating: 2 } });
    expect(JSON.stringify(entry)).not.toContain('dismissive');
  });

  /** An unrated consultation is not a data point. */
  it('reviews only consultations that were actually rated', async () => {
    const { service, consultationFindMany } = build();
    await service.listFeedback(OPERATIONS, { maxRating: 2 });
    expect(consultationFindMany.mock.calls[0][0].where).toMatchObject({
      feedbackRating: { not: null, lte: 2 },
    });
  });

  it('refuses an admin whose level does not review feedback', async () => {
    const { service } = build();
    await expect(service.listFeedback(FINANCE)).rejects.toMatchObject({ status: 403 });
  });
});

describe('SupportService — raising a complaint (FR-17.2)', () => {
  it('mints a CX ticket the patient can quote', async () => {
    const { service, complaintCreate } = build();
    await service.raiseComplaint(
      {
        category: ComplaintCategory.consultation_quality,
        subject: 'Late',
        description: 'Twenty minutes late.',
        consultationId: CONSULT,
      },
      PATIENT,
    );
    const code = complaintCreate.mock.calls[0][0].data.referenceCode as string;
    // `CX-`, not a consultation's `CC-`, so support knows which they were given.
    expect(code).toMatch(
      /^CX-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
    );
  });

  /**
   * A complaint naming somebody else's appointment would put that id in front
   * of an admin alongside this patient's name.
   */
  it('drops a consultation the patient does not own', async () => {
    const { service, complaintCreate } = build({ consultation: null });
    await service.raiseComplaint(
      {
        category: ComplaintCategory.payment_issue,
        subject: 'Charged twice',
        description: 'Two debits.',
        consultationId: 'someone-elses',
      },
      PATIENT,
    );
    expect(complaintCreate.mock.calls[0][0].data.consultationId).toBeNull();
  });

  /** Billing and app problems are not about one consultation. */
  it('allows a complaint about nothing in particular', async () => {
    const { service, complaintCreate } = build();
    await service.raiseComplaint(
      {
        category: ComplaintCategory.technical_issue,
        subject: 'App crashes',
        description: 'On open.',
      },
      PATIENT,
    );
    expect(complaintCreate.mock.calls[0][0].data.consultationId).toBeNull();
  });

  it('refuses a non-patient', async () => {
    const { service } = build();
    await expect(
      service.raiseComplaint(
        { category: ComplaintCategory.other, subject: 'x', description: 'y' },
        OPERATIONS,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * *** THE INTERNAL NOTE, THROUGH THE SERVICE. ***
 * The filter is unit-tested on its own; these prove the service actually uses it.
 */
describe('SupportService — who reads what', () => {
  const withThread = complaint({
    messages: [
      {
        authorId: 'admin-1',
        authorRole: 'admin',
        body: 'Thanks, we are looking into it.',
        isInternal: false,
        at: '2026-09-19T10:00:00.000Z',
      },
      {
        authorId: 'admin-1',
        authorRole: 'admin',
        body: 'Provider disputes the account.',
        isInternal: true,
        at: '2026-09-19T10:05:00.000Z',
      },
    ],
  });

  it('never shows the patient an internal note', async () => {
    const { service } = build({ complaint: withThread });
    const view = await service.myComplaint(COMPLAINT, PATIENT);
    expect(view.messages).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('disputes');
  });

  /** Absent, not blanked — a redacted entry still says one was written. */
  it('leaves no trace of the internal note in the patient view', async () => {
    const { service } = build({ complaint: withThread });
    const view = await service.myComplaint(COMPLAINT, PATIENT);
    expect(view.messages.every((message) => message.isInternal === false)).toBe(true);
  });

  it('shows an admin the whole thread', async () => {
    const { service } = build({ complaint: withThread });
    const view = await service.getComplaint(COMPLAINT, OPERATIONS);
    expect(view.messages).toHaveLength(2);
  });

  it('never shows the patient another patient’s complaint', async () => {
    const { service } = build({ complaint: null });
    await expect(service.myComplaint(COMPLAINT, OTHER_PATIENT)).rejects.toMatchObject({
      status: 404,
    });
  });

  /** A patient's own words are never hidden from them; the flag is set here. */
  it('never lets a patient’s own message be internal', async () => {
    const { service, executeRaw } = build();
    await service.replyAsPatient(COMPLAINT, 'Any update?', PATIENT);
    const [, appended] = executeRaw.mock.calls[0] as unknown as [unknown, string];
    const [message] = JSON.parse(appended) as { isInternal: boolean; authorRole: string }[];
    expect(message).toMatchObject({ isInternal: false, authorRole: 'patient' });
  });

  it('lets an admin write privately on the ticket', async () => {
    const { service, executeRaw } = build();
    await service.replyAsAdmin(COMPLAINT, 'Provider disputes this.', true, OPERATIONS);
    const [, appended] = executeRaw.mock.calls[0] as unknown as [unknown, string];
    const [message] = JSON.parse(appended) as { isInternal: boolean }[];
    expect(message.isInternal).toBe(true);
  });

  /** The FACT is audited; the contents are not. */
  it('audits that a private note was written, not what it said', async () => {
    const { service, audit } = build();
    await service.replyAsAdmin(COMPLAINT, 'Provider disputes this.', true, OPERATIONS);
    const entry = audit.mock.calls[0][0];
    expect(entry).toMatchObject({ metadata: { replied: true, internal: true } });
    expect(JSON.stringify(entry)).not.toContain('disputes');
  });
});

describe('SupportService — the workflow (FR-18.8)', () => {
  it('moves a complaint to in progress when somebody picks it up', async () => {
    const { service, complaintUpdate } = build();
    await service.assign(COMPLAINT, 'admin-7', OPERATIONS);
    expect(complaintUpdate.mock.calls[0][0].data).toEqual({
      assignedToAdminId: 'admin-7',
      status: ComplaintStatus.in_progress,
    });
  });

  it('resolves, stamping the time', async () => {
    const { service, complaintUpdate } = build({
      complaint: complaint({ status: ComplaintStatus.in_progress, assignedToAdminId: 'admin-1' }),
    });
    await service.close(COMPLAINT, 'resolved', 'Refunded the convenience fee.', OPERATIONS);
    const data = complaintUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: ComplaintStatus.resolved,
      resolutionNote: 'Refunded the convenience fee.',
    });
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });

  /**
   * *** REJECTED IS NOT RESOLVED. *** "We looked and disagreed" is a different
   * outcome from "we fixed it", and `resolvedAt` staying null is what keeps
   * FR-18.6's resolution count honest.
   */
  it('rejects WITHOUT setting the resolution time', async () => {
    const { service, complaintUpdate } = build({
      complaint: complaint({ status: ComplaintStatus.in_progress, assignedToAdminId: 'admin-1' }),
    });
    await service.close(
      COMPLAINT,
      'rejected',
      'Call logs show the provider joined on time.',
      OPERATIONS,
    );
    const data = complaintUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: ComplaintStatus.rejected });
    expect(data.resolvedAt).toBeNull();
    // Still explained. A patient told only "rejected" has been dismissed.
    expect(data.resolutionNote).toContain('joined on time');
  });

  it.each(['   ', ''])('refuses to close with %o as the note', async (note) => {
    const { service, complaintUpdate } = build({
      complaint: complaint({ status: ComplaintStatus.in_progress, assignedToAdminId: 'admin-1' }),
    });
    await expect(service.close(COMPLAINT, 'resolved', note, OPERATIONS)).rejects.toMatchObject({
      status: 400,
      response: { code: SupportError.RESOLUTION_NOTE_REQUIRED },
    });
    expect(complaintUpdate).not.toHaveBeenCalled();
  });

  /** Somebody has to own the decision. Whoever closes it does, if nobody had. */
  it('gives an unowned complaint an owner when it is closed', async () => {
    const { service, complaintUpdate } = build();
    await service.close(COMPLAINT, 'resolved', 'Sorted on the phone.', OPERATIONS);
    expect(complaintUpdate.mock.calls[0][0].data).toMatchObject({
      assignedToAdminId: 'admin-1',
    });
  });

  it('leaves an existing owner in place', async () => {
    const { service, complaintUpdate } = build({
      complaint: complaint({ status: ComplaintStatus.in_progress, assignedToAdminId: 'admin-7' }),
    });
    await service.close(COMPLAINT, 'resolved', 'Sorted.', OPERATIONS);
    expect(complaintUpdate.mock.calls[0][0].data).toMatchObject({
      assignedToAdminId: 'admin-7',
    });
  });

  it.each(['resolved', 'rejected'] as const)(
    'cannot close a %s complaint twice',
    async (status) => {
      const { service } = build({
        complaint: complaint({ status, assignedToAdminId: 'admin-1', resolutionNote: 'Done.' }),
      });
      await expect(
        service.close(COMPLAINT, 'resolved', 'Again.', OPERATIONS),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: SupportError.COMPLAINT_CLOSED },
      });
    },
  );

  it('refuses a patient reply once it is closed', async () => {
    const { service, executeRaw } = build({
      complaint: complaint({
        status: ComplaintStatus.resolved,
        assignedToAdminId: 'admin-1',
        resolutionNote: 'Refunded.',
      }),
    });
    await expect(service.replyAsPatient(COMPLAINT, 'I disagree.', PATIENT)).rejects.toMatchObject({
      response: { code: SupportError.COMPLAINT_CLOSED },
    });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('refuses an admin whose level does not work complaints', async () => {
    const { service } = build();
    await expect(service.listComplaints(FINANCE)).rejects.toMatchObject({ status: 403 });
    await expect(service.assign(COMPLAINT, 'admin-7', FINANCE)).rejects.toMatchObject({
      status: 403,
    });
  });

  /**
   * *** APPENDED ATOMICALLY. *** A patient replying while an admin writes an
   * internal note is ordinary; a read-modify-write would drop one of the two.
   */
  it('appends through the database rather than read-modify-write', async () => {
    const { service, executeRaw, complaintUpdate } = build();
    await service.replyAsPatient(COMPLAINT, 'Any update?', PATIENT);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(complaintUpdate).not.toHaveBeenCalled();
  });
});

import { ClarificationStatus, ClarificationUrgency } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClarificationError } from './clarification.errors';
import { CaseInput, ClarificationService } from './clarification.service';

type Row = Record<string, unknown>;

const CASE_ID = 'case-1';
const AUTHOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const EXPERT: AuthenticatedActor = { type: 'doctor', id: 'doctor-2' };
const OTHER_EXPERT: AuthenticatedActor = { type: 'doctor', id: 'doctor-3' };
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const GOVERNANCE: AuthenticatedActor = {
  type: 'admin',
  id: 'admin-1',
  level: 'clinical_governance',
};
const FINANCE: AuthenticatedActor = { type: 'admin', id: 'admin-2', level: 'finance' };

/** A clean, de-identified case. Nothing here identifies anybody. */
const CLEAN: CaseInput = {
  title: 'Treatment-resistant depression',
  patientAge: 34,
  patientGender: 'female',
  briefHistory: '34-year-old, two adequate SSRI trials, partial response.',
  diagnosis: 'Recurrent depressive disorder, current episode moderate',
  currentPlan: 'Sertraline 150mg daily, weekly CBT',
  specificDoubt: 'Augment with an atypical, or switch class?',
  urgency: ClarificationUrgency.soon,
  sourceConsultationId: 'consult-1',
};

const caseRow = (over: Row = {}) => ({
  id: CASE_ID,
  treatingDoctorId: 'doctor-1',
  sourceConsultationId: 'consult-1',
  title: CLEAN.title,
  patientAge: 34,
  patientGender: 'female',
  briefHistory: CLEAN.briefHistory,
  diagnosis: CLEAN.diagnosis,
  currentPlan: CLEAN.currentPlan,
  specificDoubt: CLEAN.specificDoubt,
  urgency: ClarificationUrgency.soon,
  expertDoctorId: null,
  assignedAt: null,
  messages: [],
  status: ClarificationStatus.draft,
  postedAt: null,
  closedAt: null,
  createdAt: new Date('2026-09-17T09:00:00.000Z'),
  updatedAt: new Date('2026-09-17T09:00:00.000Z'),
  ...over,
});

function build(over: { case?: Row | null; expert?: Row | null; consultation?: Row | null } = {}) {
  const current = over.case === undefined ? caseRow() : over.case;

  const create = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(caseRow(args.data)));
  const update = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(caseRow({ ...(current ?? {}), ...args.data })));
  const findUnique = vi.fn<() => Promise<Row | null>>().mockResolvedValue(current);
  const findFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(current);
  const findMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue(current ? [current] : []);

  const doctorFindFirst = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.expert === undefined ? { id: 'doctor-2' } : over.expert);
  const doctorFindMany = vi
    .fn<(args: Row) => Promise<Row[]>>()
    .mockResolvedValue([
      {
        id: 'doctor-2',
        fullName: 'Dr Expert',
        specialtyId: 'psychiatry',
        _count: { expertCases: 3 },
      },
    ]);

  const consultationFindFirst = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.consultation === undefined ? { id: 'consult-1' } : over.consultation);

  const executeRaw = vi.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(1);

  const prisma = {
    clarificationCase: { create, update, findUnique, findFirst, findMany },
    doctor: { findFirst: doctorFindFirst, findMany: doctorFindMany },
    consultation: { findFirst: consultationFindFirst },
    patientFile: { findMany: vi.fn<() => Promise<Row[]>>().mockResolvedValue([]) },
    $executeRaw: executeRaw,
  } as unknown as PrismaService;

  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);

  return {
    service: new ClarificationService(
      prisma,
      { record: audit } as unknown as AuditService,
      { notify } as unknown as NotificationsService,
    ),
    create,
    update,
    findFirst,
    findMany,
    doctorFindFirst,
    doctorFindMany,
    notify,
    executeRaw,
    audit,
  };
}

/**
 * *** FR-12.2, AND HALF OF M-17'S COMPLETION CRITERION. ***
 * "No shared case holds a direct identifier."
 */
describe('ClarificationService — de-identification', () => {
  it('accepts a clean case', async () => {
    const { service, create } = build();
    await expect(service.createDraft(CLEAN, AUTHOR)).resolves.toMatchObject({ title: CLEAN.title });
    expect(create).toHaveBeenCalled();
  });

  it.each([
    ['briefHistory', { ...CLEAN, briefHistory: 'Rings me on 9876543210 most nights.' }],
    [
      'specificDoubt',
      { ...CLEAN, specificDoubt: 'I mailed notes to a.k@example.com — right call?' },
    ],
    ['title', { ...CLEAN, title: 'Case for 98765 43210' }],
  ])('refuses a draft carrying an identifier in %s', async (field, input) => {
    const { service, create } = build();
    await expect(service.createDraft(input, AUTHOR)).rejects.toMatchObject({
      status: 400,
      response: { code: ClarificationError.IDENTIFIER_PRESENT },
    });
    expect(create).not.toHaveBeenCalled();
    // Nothing is written, so nothing needs redacting later.
  });

  /**
   * The error names the FIELD and the KIND and never the value. Echoing it back
   * would put the identifier into a client error body and a log line — two more
   * places than it started in.
   */
  it('never echoes the identifier back', async () => {
    const { service } = build();
    const error = await service
      .createDraft({ ...CLEAN, briefHistory: 'Call 9876543210.' }, AUTHOR)
      .catch((thrown: unknown) => thrown);
    const body = JSON.stringify((error as { getResponse(): unknown }).getResponse());
    expect(body).toContain('briefHistory');
    expect(body).toContain('phone');
    expect(body).not.toContain('9876543210');
  });

  /**
   * Scanned AGAIN at post, not only at draft. The two are not redundant: a case
   * can be edited between them, and this is the last moment before the text
   * becomes visible outside the treating relationship.
   */
  it('refuses to post a stored case that carries an identifier', async () => {
    const { service, update } = build({
      case: caseRow({ briefHistory: 'Reachable on 98765 43210 in the evenings.' }),
    });
    await expect(service.post(CASE_ID, AUTHOR)).rejects.toMatchObject({
      response: { code: ClarificationError.IDENTIFIER_PRESENT },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('scans the author’s replies too', async () => {
    const { service, executeRaw } = build({
      case: caseRow({
        status: ClarificationStatus.clarification_asked,
        expertDoctorId: 'doctor-2',
        assignedAt: new Date(),
        postedAt: new Date(),
      }),
    });
    await expect(
      service.replyAsAuthor(CASE_ID, 'She can be reached on 9876543210.', AUTHOR),
    ).rejects.toMatchObject({ response: { code: ClarificationError.IDENTIFIER_PRESENT } });
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

/**
 * *** FR-12.4, AND THE OTHER HALF OF THE COMPLETION CRITERION. ***
 * "An expert account sees only its assigned cases."
 */
describe('ClarificationService — who may see a case', () => {
  const assigned = caseRow({
    status: ClarificationStatus.awaiting_response,
    expertDoctorId: 'doctor-2',
    assignedAt: new Date('2026-09-17T10:00:00.000Z'),
    postedAt: new Date('2026-09-17T09:30:00.000Z'),
  });

  it('shows an assigned expert their case', async () => {
    const { service } = build({ case: assigned });
    await expect(service.getForExpert(CASE_ID, EXPERT)).resolves.toMatchObject({ id: CASE_ID });
  });

  /**
   * *** ELIGIBILITY ALONE NEVER GRANTS VISIBILITY. ***
   * The filter is the assignment on the row, not the seniority on the doctor.
   * An expert holding no assignment gets the same 404 a stranger would.
   */
  it('filters an expert’s read by the ASSIGNMENT, not by seniority', async () => {
    const { service, findFirst } = build({ case: assigned });
    await service.getForExpert(CASE_ID, EXPERT).catch(() => null);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: CASE_ID,
      expertDoctorId: 'doctor-2',
    });
  });

  it('refuses an expert who holds no assignment on it', async () => {
    // The query finds nothing, which is what an unassigned expert's read does.
    const { service } = build({ case: null });
    await expect(service.getForExpert(CASE_ID, OTHER_EXPERT)).rejects.toMatchObject({
      status: 404,
      response: { code: ClarificationError.CASE_NOT_FOUND },
    });
  });

  it('lists only what is assigned to the caller, and never a draft', async () => {
    const { service, findMany } = build({ case: assigned });
    await service.listAssignedToMe(EXPERT);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      expertDoctorId: 'doctor-2',
      status: { not: ClarificationStatus.draft },
    });
  });

  /**
   * *** THE REVIEWER NEVER GETS THE LINK BACK TO THE PATIENT. ***
   * `sourceConsultationId` is the one thing on the row that could identify
   * anybody, and the expert's view is built by naming every field rather than
   * by deleting from the row — so a column added later is absent here until
   * somebody decides it belongs.
   */
  it('never gives the reviewer the source consultation', async () => {
    const { service } = build({ case: assigned });
    const view = await service.getForExpert(CASE_ID, EXPERT);
    expect(view).not.toHaveProperty('sourceConsultationId');
    expect(view).not.toHaveProperty('treatingDoctorId');
    expect(JSON.stringify(view)).not.toContain('consult-1');
  });

  /** The author does get it — it is their own reference back to their patient. */
  it('gives the author their own link back', async () => {
    const { service } = build({ case: assigned });
    await expect(service.getForAuthor(CASE_ID, AUTHOR)).resolves.toMatchObject({
      sourceConsultationId: 'consult-1',
    });
  });

  it('refuses a doctor who is neither author nor assigned expert', async () => {
    const { service } = build({ case: null });
    await expect(service.getForAuthor(CASE_ID, OTHER_EXPERT)).rejects.toMatchObject({
      status: 404,
    });
  });

  /** *** FR-12.7. *** Nothing in this module is patient-facing, ever. */
  it('refuses a patient outright', async () => {
    const { service } = build({ case: assigned });
    await expect(service.getForAuthor(CASE_ID, PATIENT)).rejects.toMatchObject({ status: 404 });
    await expect(service.getForExpert(CASE_ID, PATIENT)).rejects.toMatchObject({ status: 404 });
    await expect(service.listMine(PATIENT)).rejects.toMatchObject({ status: 404 });
  });
});

describe('ClarificationService — assignment (FR-12.4, first check)', () => {
  const posted = caseRow({
    status: ClarificationStatus.posted,
    postedAt: new Date('2026-09-17T09:30:00.000Z'),
  });

  it('lists only verified doctors at expert seniority', async () => {
    const { service, doctorFindMany } = build();
    await service.eligibleExperts(GOVERNANCE);
    expect(doctorFindMany.mock.calls[0][0].where).toMatchObject({
      seniorityLevel: 'expert',
      verificationStatus: 'verified',
    });
  });

  it('assigns, and the assignment is what moves the case to the expert', async () => {
    const { service, update } = build({ case: posted });
    await service.assign(CASE_ID, 'doctor-2', GOVERNANCE);
    expect(update.mock.calls[0][0].data).toMatchObject({
      expertDoctorId: 'doctor-2',
      status: ClarificationStatus.awaiting_response,
    });
  });

  /**
   * Re-checked at the moment of assignment, not only when the list was drawn.
   * A doctor can be suspended between the two.
   */
  it('refuses a doctor who is not an eligible expert', async () => {
    const { service, update } = build({ case: posted, expert: null });
    await expect(service.assign(CASE_ID, 'doctor-9', GOVERNANCE)).rejects.toMatchObject({
      status: 409,
      response: { code: ClarificationError.NOT_AN_EXPERT },
    });
    expect(update).not.toHaveBeenCalled();
  });

  /** The whole point is a second opinion. */
  it('refuses to send a case back to its own author', async () => {
    const { service } = build({ case: posted });
    await expect(service.assign(CASE_ID, 'doctor-1', GOVERNANCE)).rejects.toMatchObject({
      response: { code: ClarificationError.EXPERT_IS_THE_AUTHOR },
    });
  });

  /** A treating doctor cannot route their own case to a friendly colleague. */
  it('is an admin’s decision, not the author’s', async () => {
    const { service } = build({ case: posted });
    await expect(service.assign(CASE_ID, 'doctor-2', AUTHOR)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.assign(CASE_ID, 'doctor-2', FINANCE)).rejects.toMatchObject({
      status: 403,
    });
  });

  /** WHICH admin chose is the audit entry — the row carries only the outcome. */
  it('records who made the assignment', async () => {
    const { service, audit } = build({ case: posted });
    await service.assign(CASE_ID, 'doctor-2', GOVERNANCE);
    expect(audit.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      entityType: 'clarification_case',
      metadata: { assignedTo: 'doctor-2' },
    });
  });

  it('refuses to assign a case still in draft', async () => {
    const { service } = build({ case: caseRow() });
    await expect(service.assign(CASE_ID, 'doctor-2', GOVERNANCE)).rejects.toMatchObject({
      response: { code: ClarificationError.NOT_IN_THAT_STATE },
    });
  });
});

describe('ClarificationService — the discussion (FR-12.5, FR-12.6)', () => {
  const withExpert = (status: ClarificationStatus) =>
    caseRow({
      status,
      expertDoctorId: 'doctor-2',
      assignedAt: new Date('2026-09-17T10:00:00.000Z'),
      postedAt: new Date('2026-09-17T09:30:00.000Z'),
    });

  /**
   * The message KIND drives the status, which is what makes the treating
   * doctor's queue meaningful: reading a paragraph to find out whether the
   * expert needs something is not triage.
   */
  it.each([
    ['comment', ClarificationStatus.response_received],
    ['clinical_consideration', ClarificationStatus.response_received],
    ['followup_recommendation', ClarificationStatus.response_received],
    ['clarification_request', ClarificationStatus.clarification_asked],
  ] as const)('an expert %s moves the case to %s', async (messageType, expected) => {
    const { service, executeRaw } = build({
      case: withExpert(ClarificationStatus.awaiting_response),
    });
    await service.replyAsExpert(CASE_ID, messageType, 'Consider augmentation.', EXPERT);

    // Prisma's tagged template is called as (strings, ...values). The message
    // and the new status go in ONE statement, so a reply can never land with
    // the case left in the state it was answering.
    const [, appended, status, id] = executeRaw.mock.calls[0] as unknown as [
      unknown,
      string,
      ClarificationStatus,
      string,
    ];
    expect(status).toBe(expected);
    expect(id).toBe(CASE_ID);

    const [message] = JSON.parse(appended) as { messageType: string; authorRole: string }[];
    expect(message).toMatchObject({ messageType, authorRole: 'expert' });
  });

  /**
   * *** APPENDED ATOMICALLY. *** Two people replying within the same second is
   * ordinary on an urgent case, and a read-modify-write would silently drop one
   * of them — an expert's advice vanishing with no trace it was ever given.
   */
  it('appends through the database rather than read-modify-write', async () => {
    const { service, executeRaw, update } = build({
      case: withExpert(ClarificationStatus.awaiting_response),
    });
    await service.replyAsExpert(CASE_ID, 'comment', 'Looks reasonable.', EXPERT);
    expect(executeRaw).toHaveBeenCalled();
    // No read-then-write of the messages column anywhere.
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an expert writing on a case that is not theirs', async () => {
    const { service, executeRaw } = build({ case: null });
    await expect(
      service.replyAsExpert(CASE_ID, 'comment', 'Hello.', OTHER_EXPERT),
    ).rejects.toMatchObject({ status: 404 });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('puts the case back with the expert when the author answers a request', async () => {
    const { service, executeRaw } = build({
      case: withExpert(ClarificationStatus.clarification_asked),
    });
    await service.replyAsAuthor(CASE_ID, 'Yes, thyroid was normal in June.', AUTHOR);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  /** Adding context to an answered case does not re-open the question. */
  it('leaves an answered case answered when the author adds context', async () => {
    const { service, executeRaw } = build({
      case: withExpert(ClarificationStatus.response_received),
    });
    await service.replyAsAuthor(CASE_ID, 'Noted, thank you.', AUTHOR);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('ClarificationService — closing out (FR-12.6, FR-12.7)', () => {
  const answered = caseRow({
    status: ClarificationStatus.response_received,
    expertDoctorId: 'doctor-2',
    assignedAt: new Date(),
    postedAt: new Date(),
  });

  /**
   * FR-12.7: marking a case reviewed records that the advice was CONSIDERED. It
   * never means it was followed — the treating doctor remains responsible for
   * the plan, and nothing reaches the patient from here.
   */
  it('lets the author mark it reviewed once there is advice to weigh', async () => {
    const { service, update } = build({ case: answered });
    await service.markReviewed(CASE_ID, AUTHOR);
    expect(update.mock.calls[0][0].data).toEqual({ status: ClarificationStatus.reviewed });
  });

  it('refuses to mark a case reviewed that nobody has answered', async () => {
    const { service } = build({
      case: caseRow({
        status: ClarificationStatus.awaiting_response,
        expertDoctorId: 'doctor-2',
        assignedAt: new Date(),
        postedAt: new Date(),
      }),
    });
    await expect(service.markReviewed(CASE_ID, AUTHOR)).rejects.toMatchObject({
      response: { code: ClarificationError.NOT_IN_THAT_STATE },
    });
  });

  it('refuses to let the expert mark it reviewed', async () => {
    const { service } = build({ case: null });
    await expect(service.markReviewed(CASE_ID, EXPERT)).rejects.toMatchObject({ status: 404 });
  });

  it('closes, setting the timestamp that IS the status', async () => {
    const { service, update } = build({ case: answered });
    await service.close(CASE_ID, AUTHOR);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: ClarificationStatus.closed });
    expect(data.closedAt).toBeInstanceOf(Date);
  });

  it('refuses to close a draft nobody ever posted', async () => {
    const { service } = build({ case: caseRow() });
    await expect(service.close(CASE_ID, AUTHOR)).rejects.toMatchObject({
      response: { code: ClarificationError.NOT_IN_THAT_STATE },
    });
  });
});

describe('ClarificationService — the draft', () => {
  it('is editable only while it is a draft', async () => {
    const { service, update } = build({
      case: caseRow({
        status: ClarificationStatus.awaiting_response,
        expertDoctorId: 'doctor-2',
        assignedAt: new Date(),
        postedAt: new Date(),
      }),
    });
    await expect(service.updateDraft(CASE_ID, CLEAN, AUTHOR)).rejects.toMatchObject({
      status: 409,
      response: { code: ClarificationError.ALREADY_POSTED },
    });
    expect(update).not.toHaveBeenCalled();
  });

  /** Only the author's OWN consultation may be referenced. */
  it('drops a consultation the author did not hold', async () => {
    const { service, create } = build({ consultation: null });
    await service.createDraft(CLEAN, AUTHOR);
    expect(create.mock.calls[0][0].data.sourceConsultationId).toBeNull();
  });

  it('posts a clean draft and stamps the time', async () => {
    const { service, update } = build();
    await service.post(CASE_ID, AUTHOR);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: ClarificationStatus.posted });
    expect(data.postedAt).toBeInstanceOf(Date);
  });
});

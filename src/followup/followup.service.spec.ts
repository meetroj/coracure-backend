import { FollowupStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { DEFAULT_PATHWAYS } from './default-pathways';
import { FollowupError } from './followup.errors';
import { FollowupService } from './followup.service';
import { RaiseAlert, SafetyAlertsService } from './safety-alerts.service';

type Row = Record<string, unknown>;

const CONSULT = 'consult-1';
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const OTHER_PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-9' };
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OTHER_DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };

const DEPRESSION = DEFAULT_PATHWAYS[0];
const STARTS_ON = new Date('2026-09-15T00:00:00.000Z');
/** Day 2 of a seven-day window that began on the 15th. */
const DAY_TWO = new Date('2026-09-16T19:00:00.000Z');

const pathway = (over: Row = {}) => ({
  id: 'pathway-v1',
  code: DEPRESSION.code,
  name: DEPRESSION.name,
  version: 1,
  durationDays: 7,
  questions: DEPRESSION.questions,
  redFlagRules: DEPRESSION.redFlagRules,
  isCurrent: true,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  ...over,
});

const consultation = (over: Row = {}) => ({
  id: CONSULT,
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  followupPathwayId: 'pathway-v1',
  followupStartsOn: STARTS_ON,
  followupStatus: FollowupStatus.active,
  extraCheckinQuestions: [],
  ...over,
});

/** Every required question of the depression pathway, answered safely. */
const SAFE_ANSWERS = {
  mood: 'better',
  anxiety: 'none',
  self_harm: 'no',
  feeling_unsafe: 'no',
  medication: 'yes',
  side_effects: 'none',
};

function build(
  over: {
    consultation?: Row | null;
    pathway?: Row | null;
    record?: Row | null;
    createThrows?: Error;
    existingCheckin?: Row | null;
  } = {},
) {
  const consultationFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.consultation === undefined ? consultation() : over.consultation);
  const consultationUpdate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(consultation(args.data)));

  const pathwayFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.pathway === undefined ? pathway() : over.pathway);
  const pathwayFindFirst = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.pathway === undefined ? pathway() : over.pathway);

  const recordFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(
      over.record === undefined
        ? { finalisedAt: new Date('2026-09-14T12:00:00.000Z') }
        : over.record,
    );

  const checkinCreate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => {
      if (over.createThrows) return Promise.reject(over.createThrows);
      return Promise.resolve({ id: 'checkin-1', ...args.data });
    });
  const checkinFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.existingCheckin ?? null);
  const checkinFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([]);

  const prisma = {
    consultation: { findUnique: consultationFindUnique, update: consultationUpdate },
    followupPathway: { findUnique: pathwayFindUnique, findFirst: pathwayFindFirst },
    clinicalRecord: { findUnique: recordFindUnique },
    checkinResponse: {
      create: checkinCreate,
      findUnique: checkinFindUnique,
      findMany: checkinFindMany,
    },
    patient: {
      findUnique: vi.fn<() => Promise<Row>>().mockResolvedValue({ fullName: 'A. Patient' }),
    },
  } as unknown as PrismaService;

  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const raise = vi.fn<(input: RaiseAlert) => Promise<Row>>().mockResolvedValue({});

  return {
    service: new FollowupService(
      prisma,
      { record: audit } as unknown as AuditService,
      { raise } as unknown as SafetyAlertsService,
    ),
    consultationUpdate,
    checkinCreate,
    raise,
    audit,
  };
}

describe('FollowupService — assigning a plan (FR-9.7)', () => {
  /**
   * *** THE VERSION IS PINNED, NOT THE CODE. ***
   * A patient answers the same questions for all seven days even if an admin
   * publishes a revision on day three. Comparing day two with day six is the
   * whole value of a daily check-in.
   */
  it('pins the pathway version the patient will answer', async () => {
    const { service, consultationUpdate } = build();
    await service.assign(CONSULT, { pathwayCode: DEPRESSION.code }, DOCTOR);
    expect(consultationUpdate.mock.calls[0][0].data).toMatchObject({
      followupPathwayId: 'pathway-v1',
      followupStatus: 'active',
    });
  });

  /**
   * A follow-up plan is part of the treatment. Assigning one before the
   * consultation is written up would put a patient on daily check-ins for a
   * case nobody had closed.
   */
  it('refuses until the clinical record is finalised', async () => {
    const { service, consultationUpdate } = build({ record: { finalisedAt: null } });
    await expect(
      service.assign(CONSULT, { pathwayCode: DEPRESSION.code }, DOCTOR),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: FollowupError.NOT_YET_DOCUMENTED },
    });
    expect(consultationUpdate).not.toHaveBeenCalled();
  });

  it('refuses when there is no record at all', async () => {
    const { service } = build({ record: null });
    await expect(
      service.assign(CONSULT, { pathwayCode: DEPRESSION.code }, DOCTOR),
    ).rejects.toMatchObject({ response: { code: FollowupError.NOT_YET_DOCUMENTED } });
  });

  it('refuses a pathway that is not published', async () => {
    const { service } = build({ pathway: null });
    await expect(
      service.assign(CONSULT, { pathwayCode: 'nonsense' }, DOCTOR),
    ).rejects.toMatchObject({ status: 404, response: { code: FollowupError.PATHWAY_NOT_FOUND } });
  });

  it('refuses a doctor who did not hold the consultation', async () => {
    const { service } = build();
    await expect(
      service.assign(CONSULT, { pathwayCode: DEPRESSION.code }, OTHER_DOCTOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * A check-in on the day of the consultation asks how the last 24 hours
   * compare with a day that contained the appointment, which answers nothing.
   */
  it('starts tomorrow by default', async () => {
    const { service, consultationUpdate } = build();
    await service.assign(CONSULT, { pathwayCode: DEPRESSION.code }, DOCTOR);
    const startsOn = consultationUpdate.mock.calls[0][0].data.followupStartsOn as Date;
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(startsOn.toISOString().slice(0, 10)).toBe(tomorrow.toISOString().slice(0, 10));
  });

  it('records the doctor’s own extra questions (FR-13.8)', async () => {
    const { service, consultationUpdate } = build();
    const extra = [{ id: 'sleep_hours', text: 'Hours slept?', type: 'text' as const }];
    await service.assign(CONSULT, { pathwayCode: DEPRESSION.code, extraQuestions: extra }, DOCTOR);
    expect(consultationUpdate.mock.calls[0][0].data.extraCheckinQuestions).toEqual(extra);
  });
});

describe('FollowupService — the daily check-in (FR-13.1 to FR-13.5)', () => {
  it('records a green day and raises nothing', async () => {
    const { service, checkinCreate, raise } = build();
    const result = await service.submitCheckin(CONSULT, SAFE_ANSWERS, PATIENT, DAY_TWO);

    expect(result.status).toBe('green');
    expect(result.showEmergencyGuidance).toBe(false);
    expect(checkinCreate.mock.calls[0][0].data).toMatchObject({ status: 'green' });
    // FR-13.2: check-ins and the care plan simply continue.
    expect(raise).not.toHaveBeenCalled();
  });

  it('raises one amber alert for a worsening day', async () => {
    const { service, raise } = build();
    const result = await service.submitCheckin(
      CONSULT,
      { ...SAFE_ANSWERS, medication: 'some' },
      PATIENT,
      DAY_TWO,
    );
    expect(result.status).toBe('amber');
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0][0]).toMatchObject({ alertType: 'amber', consultationId: CONSULT });
  });

  /**
   * *** SRS 6.3. *** Emergency guidance is shown IMMEDIATELY, on the strength of
   * this flag alone. It does not wait for the doctor or the care coordinator to
   * respond to the alert.
   */
  it('tells the app to show emergency guidance at once on a red day', async () => {
    const { service, raise } = build();
    const result = await service.submitCheckin(
      CONSULT,
      { ...SAFE_ANSWERS, self_harm: 'yes' },
      PATIENT,
      DAY_TWO,
    );

    expect(result.status).toBe('red');
    expect(result.showEmergencyGuidance).toBe(true);
    expect(result.reasons).toEqual(['Reported thoughts of self-harm on the daily check-in.']);
    expect(raise.mock.calls[0][0]).toMatchObject({
      alertType: 'red_flag',
      reason: 'Reported thoughts of self-harm on the daily check-in.',
    });
  });

  /**
   * FR-9.8 keeps a side effect as its own type, because it is acted on
   * differently: it usually means a prescription needs changing rather than
   * that somebody is in danger.
   */
  it('raises a side effect under its own alert type', async () => {
    const { service, raise } = build();
    await service.submitCheckin(
      CONSULT,
      { ...SAFE_ANSWERS, side_effects: 'troubling' },
      PATIENT,
      DAY_TWO,
    );
    expect(raise.mock.calls[0][0]).toMatchObject({ alertType: 'medication_side_effect' });
  });

  /**
   * One alert per distinct finding, not one per rule. A queue with the same
   * patient three times for one answer is a queue nobody trusts.
   */
  it('raises one alert per category when several rules fire', async () => {
    const { service, raise } = build();
    await service.submitCheckin(
      CONSULT,
      { ...SAFE_ANSWERS, self_harm: 'yes', feeling_unsafe: 'yes', mood: 'much_worse' },
      PATIENT,
      DAY_TWO,
    );
    const categories = raise.mock.calls.map((call) => call[0].reason);
    expect(new Set(categories).size).toBe(raise.mock.calls.length);
    expect(raise).toHaveBeenCalledTimes(3);
  });

  /**
   * *** FR-13.8, THROUGH THE SERVICE. *** The doctor's own question uses an
   * approved question's id and an amber-flagged option. It must still not
   * grade the day.
   */
  it('never lets a doctor’s own question change the status', async () => {
    const { service } = build({
      consultation: consultation({
        extraCheckinQuestions: [
          {
            id: 'mood',
            text: 'My own mood question',
            type: 'single_choice',
            options: [{ value: 'worse', label: 'Worse', flag: 'amber' }],
          },
        ],
      }),
    });
    const result = await service.submitCheckin(
      CONSULT,
      { ...SAFE_ANSWERS, mood: 'worse' },
      PATIENT,
      DAY_TWO,
    );
    expect(result.status).toBe('green');
  });

  it('refuses a check-in missing a required answer', async () => {
    const { service, checkinCreate } = build();
    await expect(
      service.submitCheckin(CONSULT, { mood: 'better' }, PATIENT, DAY_TWO),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: FollowupError.CHECKIN_INCOMPLETE },
    });
    expect(checkinCreate).not.toHaveBeenCalled();
  });

  /**
   * *** ONE PER DAY. *** A second submission must not overwrite an answer a
   * clinician may already have acted on: correcting it is a conversation, not a
   * form resubmission.
   */
  it('refuses a second check-in on the same day', async () => {
    const { service } = build({
      createThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    await expect(
      service.submitCheckin(CONSULT, SAFE_ANSWERS, PATIENT, DAY_TWO),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: FollowupError.ALREADY_CHECKED_IN },
    });
  });

  it('does not swallow a database failure that is not a duplicate', async () => {
    const { service } = build({
      createThrows: Object.assign(new Error('connection lost'), { code: 'P1001' }),
    });
    await expect(service.submitCheckin(CONSULT, SAFE_ANSWERS, PATIENT, DAY_TWO)).rejects.toThrow(
      'connection lost',
    );
  });

  it.each([
    ['before it starts', new Date('2026-09-14T10:00:00.000Z')],
    ['after it ends', new Date('2026-09-25T10:00:00.000Z')],
  ])('refuses a check-in %s', async (_case, when) => {
    const { service } = build();
    await expect(service.submitCheckin(CONSULT, SAFE_ANSWERS, PATIENT, when)).rejects.toMatchObject(
      { status: 409, response: { code: FollowupError.OUTSIDE_WINDOW } },
    );
  });

  it.each(['none', 'completed', 'cancelled'])(
    'refuses a check-in when the follow-up is %s',
    async (status) => {
      const { service } = build({ consultation: consultation({ followupStatus: status }) });
      await expect(
        service.submitCheckin(CONSULT, SAFE_ANSWERS, PATIENT, DAY_TWO),
      ).rejects.toMatchObject({ response: { code: FollowupError.FOLLOWUP_NOT_ACTIVE } });
    },
  );

  it('refuses a patient who is not the one on the consultation', async () => {
    const { service } = build();
    await expect(
      service.submitCheckin(CONSULT, SAFE_ANSWERS, OTHER_PATIENT, DAY_TWO),
    ).rejects.toMatchObject({ status: 404 });
  });

  /** The doctor reads the answers; they never submit them. */
  it('refuses a doctor submitting on the patient’s behalf', async () => {
    const { service } = build();
    await expect(
      service.submitCheckin(CONSULT, SAFE_ANSWERS, DOCTOR, DAY_TWO),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('FollowupService — what the patient is asked', () => {
  it('shows the approved set plus the doctor’s, marked', async () => {
    const { service } = build({
      consultation: consultation({
        extraCheckinQuestions: [{ id: 'sleep_hours', text: 'Hours slept?', type: 'text' }],
      }),
    });
    const today = await service.todaysCheckin(CONSULT, PATIENT, DAY_TWO);
    expect(today.day).toBe(2);
    expect(today.ofDays).toBe(7);
    expect(today.submitted).toBe(false);
    expect(today.questions.at(-1)).toMatchObject({ id: 'sleep_hours', addedByDoctor: true });
  });

  it('says when today has already been answered', async () => {
    const { service } = build({ existingCheckin: { id: 'checkin-1' } });
    const today = await service.todaysCheckin(CONSULT, PATIENT, DAY_TWO);
    expect(today.submitted).toBe(true);
  });
});

describe('FollowupService — the plan', () => {
  it('computes the end date from the pinned pathway, never a column', async () => {
    const { service } = build();
    const plan = await service.planFor(CONSULT, PATIENT);
    expect(plan.startsOn).toEqual(STARTS_ON);
    expect(plan.endsOn?.toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(plan.durationDays).toBe(7);
    expect(plan.pathway).toMatchObject({ code: 'depression_anxiety', version: 1 });
  });

  it('is readable by both parties and nobody else', async () => {
    const { service } = build();
    await expect(service.planFor(CONSULT, DOCTOR)).resolves.toMatchObject({ status: 'active' });
    await expect(service.planFor(CONSULT, OTHER_PATIENT)).rejects.toMatchObject({ status: 404 });
  });

  /** The one state no date arithmetic can produce, which is why the column stays. */
  it('can be cancelled early by the treating doctor', async () => {
    const { service, consultationUpdate } = build();
    await service.cancel(CONSULT, DOCTOR);
    expect(consultationUpdate.mock.calls[0][0].data).toEqual({ followupStatus: 'cancelled' });
  });
});

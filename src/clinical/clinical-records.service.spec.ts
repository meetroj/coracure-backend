import { ConsultationStatus, RiskCategory } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { SpecialtyCatalogue } from '../doctors/specialty-catalogue';
import { PatientFileStorage } from '../files/patient-file-storage';
import { PatientFilesService } from '../files/patient-files.service';
import { PresenceService } from '../instant/presence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClinicalRecordsService } from './clinical-records.service';
import { ClinicalError } from './clinical.errors';
import { SaveClinicalRecordDto } from './dto/clinical.dto';

type Row = Record<string, unknown>;

const CONSULT = 'consult-1';
const DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-1' };
const OTHER_DOCTOR: AuthenticatedActor = { type: 'doctor', id: 'doctor-9' };
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'clinical_governance' };

const SUMMARY = ['Low mood for three weeks.', 'Started an SSRI.', 'Review in four weeks.'].join(
  '\n',
);

const MEDICINE = {
  name: 'Sertraline 50mg',
  dose: '1 tablet',
  frequency: 'Once daily',
  duration: '4 weeks',
};

const consultation = (over: Row = {}) => ({
  id: CONSULT,
  patientId: 'patient-1',
  doctorId: 'doctor-1',
  referenceCode: 'CC-TEST-0001',
  status: ConsultationStatus.awaiting_documentation,
  scheduledStartAt: new Date('2026-09-14T10:00:00.000Z'),
  ...over,
});

const record = (over: Row = {}) => ({
  id: 'record-1',
  consultationId: CONSULT,
  chiefComplaint: 'Low mood and poor sleep.',
  clinicalHistory: null,
  diagnosis: 'Moderate depressive episode',
  isDiagnosisProvisional: true,
  riskCategory: RiskCategory.moderate,
  referralNote: null,
  medicines: [],
  adviceCovered: 'Discussed sleep hygiene.',
  adviceHomePractice: null,
  adviceNextFocus: null,
  adviceWarningSigns: null,
  caseSummary: SUMMARY,
  recommendedContentIds: [],
  finalisedAt: null,
  createdAt: new Date('2026-09-14T10:30:00.000Z'),
  updatedAt: new Date('2026-09-14T10:30:00.000Z'),
  ...over,
});

const input = (over: Partial<SaveClinicalRecordDto> = {}): SaveClinicalRecordDto => ({
  chiefComplaint: 'Low mood and poor sleep.',
  riskCategory: RiskCategory.moderate,
  adviceCovered: 'Discussed sleep hygiene.',
  caseSummary: SUMMARY,
  ...over,
});

function build(
  over: {
    consultation?: Row | null;
    record?: Row | null;
    canPrescribe?: boolean;
    /** Ids M-18 says are not published, so cannot be recommended. */
    unrecommendable?: string[];
    specialtyId?: string | null;
    pending?: Row[];
    clearGateThrows?: Error;
  } = {},
) {
  const consultationFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.consultation === undefined ? consultation() : over.consultation);
  const consultationFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue(over.pending ?? []);
  const consultationUpdate = vi.fn<(args: { data: Row }) => Promise<Row>>().mockResolvedValue({});

  const recordFindUnique = vi
    .fn<() => Promise<Row | null>>()
    .mockResolvedValue(over.record === undefined ? record() : over.record);
  const recordUpsert = vi
    .fn<(args: { create: Row; update: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(record(args.update)));
  const recordUpdate = vi
    .fn<(args: { data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(record(args.data)));

  const doctorFindUnique = vi
    .fn<() => Promise<Row | null>>()
    // `??` would not tell "not set by this test" from "deliberately null",
    // which is the very case the no-specialty test is about.
    .mockResolvedValue({
      specialtyId: over.specialtyId === undefined ? 'psychiatry' : over.specialtyId,
    });

  const patientFindUnique = vi.fn<() => Promise<Row | null>>().mockResolvedValue({
    fullName: 'Anita Sharma',
    dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    gender: 'female',
  });

  const prisma = {
    consultation: {
      findUnique: consultationFindUnique,
      findMany: consultationFindMany,
      update: consultationUpdate,
    },
    clinicalRecord: {
      findUnique: recordFindUnique,
      upsert: recordUpsert,
      update: recordUpdate,
    },
    doctor: { findUnique: doctorFindUnique },
    patient: { findUnique: patientFindUnique },
    // The two writes finalise makes are one event, so they go together. The
    // stub returns what the real client would: each operation's result.
    $transaction: vi
      .fn<(operations: Promise<Row>[]) => Promise<Row[]>>()
      .mockImplementation((operations) => Promise.all(operations)),
  } as unknown as PrismaService;

  const audit = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const clearCompletionGate = vi.fn<() => Promise<void>>().mockImplementation(() => {
    if (over.clearGateThrows) return Promise.reject(over.clearGateThrows);
    return Promise.resolve();
  });

  const canPrescribe = vi.fn<() => Promise<boolean>>().mockResolvedValue(over.canPrescribe ?? true);
  const notify = vi.fn<() => Promise<null>>().mockResolvedValue(null);
  const storeGeneratedPdf = vi.fn<() => Promise<Row>>().mockResolvedValue({});
  const put = vi
    .fn<(key: string, body: Uint8Array, contentType: string) => Promise<void>>()
    .mockResolvedValue(undefined);

  // M-18's library, through the port M-15 declares. By default everything the
  // doctor picked is recommendable; `unrecommendable` overrides that.
  const unrecommendable = vi
    .fn<(ids: string[]) => Promise<string[]>>()
    .mockResolvedValue(over.unrecommendable ?? []);

  return {
    service: new ClinicalRecordsService(
      prisma,
      { record: audit } as unknown as AuditService,
      { clearCompletionGate } as unknown as PresenceService,
      { notify } as unknown as NotificationsService,
      { storeGeneratedPdf } as unknown as PatientFilesService,
      { canPrescribe } as unknown as SpecialtyCatalogue,
      { unrecommendable, summaries: () => Promise.resolve([]) },
      { put } as unknown as PatientFileStorage,
    ),
    recordUpsert,
    unrecommendable,
    recordUpdate,
    storeGeneratedPdf,
    put,
    consultationUpdate,
    clearCompletionGate,
    canPrescribe,
    doctorFindUnique,
    audit,
  };
}

/**
 * *** "A NON-PRESCRIBING PROFESSIONAL CANNOT SAVE A MEDICINE." ***
 * One of M-15's three completion criteria.
 */
describe('ClinicalRecordsService — scope of practice (FR-4.3)', () => {
  it('lets a prescribing specialty save medicines', async () => {
    const { service, recordUpsert } = build({ canPrescribe: true });
    await service.save(CONSULT, input({ medicines: [MEDICINE] }), DOCTOR);
    expect(recordUpsert.mock.calls[0][0].update.medicines as Row[]).toHaveLength(1);
  });

  it('refuses a medicine from a specialty that may not prescribe', async () => {
    const { service, recordUpsert } = build({ canPrescribe: false });
    await expect(
      service.save(CONSULT, input({ medicines: [MEDICINE] }), DOCTOR),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: ClinicalError.PRESCRIBING_NOT_PERMITTED },
    });
    // Refused BEFORE anything is written, so the record is left as it was.
    expect(recordUpsert).not.toHaveBeenCalled();
  });

  /** Their closing record is the advice plan, and that must still save. */
  it('lets a non-prescribing specialty save everything else', async () => {
    const { service, recordUpsert } = build({ canPrescribe: false });
    await service.save(CONSULT, input(), DOCTOR);
    expect(recordUpsert.mock.calls[0][0].update).toMatchObject({
      adviceCovered: 'Discussed sleep hygiene.',
    });
  });

  /**
   * Eligibility is a property of the PROFESSIONAL'S specialty, asked of M-06
   * through the port M-05 declared — not of the service booked, and never
   * decided here.
   */
  it('asks the catalogue about the doctor’s own specialty', async () => {
    const { service, canPrescribe, doctorFindUnique } = build({ specialtyId: 'psychology' });
    await service.save(CONSULT, input(), DOCTOR);
    expect(doctorFindUnique).toHaveBeenCalled();
    expect(canPrescribe).toHaveBeenCalledWith('psychology');
  });

  /** A rule that cannot be evaluated must refuse rather than allow. */
  it('treats a doctor with no specialty as unable to prescribe', async () => {
    const { service, canPrescribe } = build({ specialtyId: null });
    await service.save(CONSULT, input(), DOCTOR);
    expect(canPrescribe).toHaveBeenCalledWith(null);
  });
});

/**
 * *** "A CONSULTATION CANNOT BE MARKED COMPLETE WITH A MISSING PRESCRIPTION OR
 * ADVICE AND SUMMARY." *** FR-11.5, and the second completion criterion.
 */
describe('ClinicalRecordsService — completing the case (FR-11.5)', () => {
  it('freezes the record, completes the consultation and opens the gate together', async () => {
    const { service, recordUpdate, consultationUpdate, clearCompletionGate } = build();
    const view = await service.finalise(CONSULT, DOCTOR);

    expect(recordUpdate.mock.calls[0][0].data.finalisedAt).toBeInstanceOf(Date);
    expect(consultationUpdate.mock.calls[0][0].data).toEqual({ status: 'completed' });
    // FR-10.5: the doctor is free to take their next instant consult.
    expect(clearCompletionGate).toHaveBeenCalledWith('doctor-1');
    expect(view.finalisedAt).toBeInstanceOf(Date);
  });

  /** FR-9.5's PDF: `storeGeneratedPdf`'s one caller. */
  it('renders and stores a prescription PDF', async () => {
    const { service, put, storeGeneratedPdf } = build();
    await service.finalise(CONSULT, DOCTOR);

    expect(put).toHaveBeenCalledTimes(1);
    const [key, bytes, contentType] = put.mock.calls[0];
    expect(key).toMatch(/^patient-files\/patient-1\/prescription_pdf\//);
    expect(bytes.length).toBeGreaterThan(0);
    expect(contentType).toBe('application/pdf');

    expect(storeGeneratedPdf).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'patient-1', consultationId: CONSULT, doctorId: 'doctor-1' }),
    );
  });

  it('finalising still succeeds even if the PDF cannot be rendered', async () => {
    const { service, put } = build();
    put.mockRejectedValueOnce(new Error('s3 down'));
    const view = await service.finalise(CONSULT, DOCTOR);
    expect(view.finalisedAt).toBeInstanceOf(Date);
  });

  it('refuses while anything is outstanding, and says what', async () => {
    const { service, recordUpdate, consultationUpdate } = build({
      record: record({ caseSummary: null }),
    });
    await expect(service.finalise(CONSULT, DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: {
        code: ClinicalError.RECORD_INCOMPLETE,
        details: { outstanding: [{ code: 'CASE_SUMMARY_MISSING' }] },
      },
    });
    expect(recordUpdate).not.toHaveBeenCalled();
    expect(consultationUpdate).not.toHaveBeenCalled();
  });

  it('refuses a non-prescribing professional who wrote no advice plan', async () => {
    const { service } = build({
      canPrescribe: false,
      record: record({ adviceCovered: null }),
    });
    await expect(service.finalise(CONSULT, DOCTOR)).rejects.toMatchObject({
      response: { details: { outstanding: [{ code: 'ADVICE_MISSING' }] } },
    });
  });

  it('refuses to finalise a consultation with no record at all', async () => {
    const { service } = build({ record: null });
    await expect(service.finalise(CONSULT, DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: ClinicalError.RECORD_NOT_FOUND },
    });
  });

  /**
   * The gate is another module's row. A failure to open it must not roll back a
   * finalised clinical record: the case IS documented either way, and a gate
   * that stays shut is a support call rather than a lost record.
   */
  it('still finalises when the completion gate cannot be opened', async () => {
    const { service, recordUpdate } = build({ clearGateThrows: new Error('presence down') });
    const view = await service.finalise(CONSULT, DOCTOR);
    expect(view.finalisedAt).toBeInstanceOf(Date);
    expect(recordUpdate).toHaveBeenCalled();
  });
});

/**
 * *** THE RECORD FREEZES. *** A finalised record is evidence: a prescription
 * the patient holds a PDF of, and the handover the next clinician reads.
 */
describe('ClinicalRecordsService — the freeze', () => {
  it('refuses to change a finalised record', async () => {
    const finalisedAt = new Date('2026-09-14T11:00:00.000Z');
    const { service, recordUpsert } = build({ record: record({ finalisedAt }) });
    await expect(service.save(CONSULT, input(), DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: ClinicalError.RECORD_FINALISED, details: { finalisedAt } },
    });
    expect(recordUpsert).not.toHaveBeenCalled();
  });

  it('refuses to finalise one twice', async () => {
    const { service } = build({ record: record({ finalisedAt: new Date() }) });
    await expect(service.finalise(CONSULT, DOCTOR)).rejects.toMatchObject({
      response: { code: ClinicalError.RECORD_FINALISED },
    });
  });
});

describe('ClinicalRecordsService — who may write', () => {
  it('refuses a doctor who did not hold the consultation', async () => {
    const { service } = build();
    await expect(service.save(CONSULT, input(), OTHER_DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: ClinicalError.CONSULTATION_NOT_FOUND },
    });
  });

  /** An admin reads a record for governance; nobody but the clinician writes one. */
  it('refuses an admin, who is accountable for nothing clinical', async () => {
    const { service } = build();
    await expect(service.save(CONSULT, input(), ADMIN)).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['scheduled', 'has not been held'],
    ['pending_payment', 'has not been held'],
    ['cancelled', 'has not been held'],
  ])('refuses documentation on a %s consultation', async (status) => {
    const { service } = build({ consultation: consultation({ status }), record: null });
    await expect(service.save(CONSULT, input(), DOCTOR)).rejects.toMatchObject({
      status: 409,
      response: { code: ClinicalError.NOT_DOCUMENTABLE },
    });
  });

  /** Doctors write notes DURING a consultation as often as after it. */
  it('allows documentation while the call is still running', async () => {
    const { service, recordUpsert } = build({
      consultation: consultation({ status: ConsultationStatus.in_progress }),
      record: null,
    });
    await service.save(CONSULT, input(), DOCTOR);
    expect(recordUpsert).toHaveBeenCalled();
  });
});

describe('ClinicalRecordsService — what each party is shown', () => {
  it('gives the doctor the whole record plus what it still needs', async () => {
    const { service } = build({ record: record({ caseSummary: null }) });
    const view = await service.forDoctor(CONSULT, DOCTOR);
    expect(view.caseSummary).toBeNull();
    expect(view.outstanding.map((o) => o.code)).toContain('CASE_SUMMARY_MISSING');
    expect(view.canPrescribe).toBe(true);
  });

  /**
   * The patient gets the treatment, not the clinical reasoning: no case summary
   * (a handover written for the next clinician) and no risk category (a triage
   * decision that reads quite differently to the person it is about).
   */
  it('gives the patient the treatment and none of the reasoning', async () => {
    const { service } = build({
      record: record({ finalisedAt: new Date('2026-09-14T11:00:00.000Z'), medicines: [MEDICINE] }),
    });
    const view = await service.forPatient(CONSULT, PATIENT);
    expect(view.medicines).toHaveLength(1);
    expect(view.diagnosis).toBe('Moderate depressive episode');
    expect(view).not.toHaveProperty('caseSummary');
    expect(view).not.toHaveProperty('riskCategory');
    expect(view).not.toHaveProperty('clinicalHistory');
  });

  /** Half a prescription is worse than none. */
  it('shows the patient nothing until the doctor has issued it', async () => {
    const { service } = build({ record: record({ finalisedAt: null }) });
    await expect(service.forPatient(CONSULT, PATIENT)).rejects.toMatchObject({
      status: 404,
      response: { code: ClinicalError.RECORD_NOT_FOUND },
    });
  });

  it('refuses a patient who is not the one on the consultation', async () => {
    const { service } = build({ record: record({ finalisedAt: new Date() }) });
    await expect(
      service.forPatient(CONSULT, { type: 'patient', id: 'patient-9' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lets clinical governance read a record it could never write', async () => {
    const { service } = build();
    await expect(service.forAdmin(CONSULT, ADMIN)).resolves.toMatchObject({
      consultationId: CONSULT,
    });
  });

  it('refuses an admin whose permission level does not cover it', async () => {
    const { service } = build();
    await expect(
      service.forAdmin(CONSULT, { type: 'admin', id: 'a-2', level: 'finance' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/** FR-9.3's worklist. The most outstanding case is the one with no record yet. */
describe('ClinicalRecordsService — the pending worklist (FR-9.3)', () => {
  it('lists a held consultation that was never opened, as fully outstanding', async () => {
    const { service } = build({
      pending: [{ ...consultation(), clinicalRecord: null }],
    });
    const [item] = await service.pendingFor('doctor-1');
    expect(item.startedAt).toBeNull();
    expect(item.outstanding.map((o) => o.code)).toEqual([
      'CASE_SUMMARY_MISSING',
      'PRESCRIPTION_OR_ADVICE_MISSING',
    ]);
  });

  it('lists a started record with only what is left', async () => {
    const { service } = build({
      pending: [{ ...consultation(), clinicalRecord: record({ caseSummary: null }) }],
    });
    const [item] = await service.pendingFor('doctor-1');
    expect(item.startedAt).toBeInstanceOf(Date);
    expect(item.outstanding.map((o) => o.code)).toEqual(['CASE_SUMMARY_MISSING']);
  });

  it('is empty when everything is written up', async () => {
    const { service } = build({ pending: [] });
    await expect(service.pendingFor('doctor-1')).resolves.toEqual([]);
  });
});

/**
 * *** FR-15.4, AND THE GAP M-18 CLOSED. ***
 *
 * Before the Care Hub existed these ids were stored unchecked. A typo, or an
 * item archived since, put a broken link on the Care Plan of a patient who had
 * been told to read it — and nobody found out until they tapped it.
 *
 * M-15 asks through the `CONTENT_LIBRARY` port rather than importing M-18: this
 * module was written first and does not depend on it directly.
 */
describe('ClinicalRecordsService — the doctor’s Care Hub picks (FR-15.4)', () => {
  it('stores picks the library says are published', async () => {
    const { service, recordUpsert } = build();
    await service.save(CONSULT, input({ recommendedContentIds: ['tool-1', 'article-2'] }), DOCTOR);
    expect(recordUpsert.mock.calls[0][0].create).toMatchObject({
      recommendedContentIds: ['tool-1', 'article-2'],
    });
  });

  /**
   * Refused, and the offender NAMED — so the doctor drops one pick rather than
   * losing the whole selection and having to guess which was wrong.
   */
  it('refuses a pick that is not a published item, and says which', async () => {
    const { service, recordUpsert } = build({ unrecommendable: ['archived-9'] });
    const error = await service
      .save(CONSULT, input({ recommendedContentIds: ['tool-1', 'archived-9'] }), DOCTOR)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ status: 400 });
    expect(
      (error as { getResponse(): { code: string; details: { rejected: string[] } } }).getResponse(),
    ).toMatchObject({
      code: ClinicalError.CONTENT_NOT_RECOMMENDABLE,
      details: { rejected: ['archived-9'] },
    });
    expect(recordUpsert).not.toHaveBeenCalled();
  });

  /** No picks, no question to ask. */
  it('does not consult the library for an empty selection', async () => {
    const { service, unrecommendable } = build();
    await service.save(CONSULT, input({ recommendedContentIds: [] }), DOCTOR);
    expect(unrecommendable).not.toHaveBeenCalled();
  });
});

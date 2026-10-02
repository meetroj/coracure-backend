import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { RegionsService } from '../catalogue/regions.service';
import { PatientAssignment } from './patient-assignment';
import { PatientProfileService } from './patient-profile.service';

type Row = Record<string, unknown>;
type UpdateArgs = { where: { id: string }; data: Row };

const patient = (over: Row = {}) => ({
  id: 'patient-1',
  mobileNumber: '+919876543210',
  fullName: 'Anita Sharma',
  dateOfBirth: new Date('1990-04-17T00:00:00.000Z'),
  gender: 'female',
  preferredLanguage: 'en',
  status: 'active',
  ...over,
});

function build(over: { row?: Row | null; treating?: boolean; regionUsable?: boolean } = {}) {
  const found = over.row === undefined ? patient() : over.row;
  const findUnique = vi.fn().mockResolvedValue(found);
  const update = vi
    .fn<(args: UpdateArgs) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve({ ...(found as Row), ...args.data }));
  const prisma = { patient: { findUnique, update } } as unknown as PrismaService;

  const record = vi.fn().mockResolvedValue(undefined);
  const isDoctorTreating = vi.fn().mockResolvedValue(over.treating ?? false);
  const assignment = { isDoctorTreating } as unknown as PatientAssignment;

  const assertUsable = vi.fn();
  assertUsable.mockResolvedValue(undefined);
  if (over.regionUsable === false) {
    assertUsable.mockRejectedValue(Object.assign(new Error('retired'), { status: 400 }));
  }
  const regions = { assertUsable } as unknown as RegionsService;

  return {
    service: new PatientProfileService(
      prisma,
      { record } as unknown as AuditService,
      assignment,
      regions,
    ),
    update,
    record,
    isDoctorTreating,
    assertUsable,
  };
}

describe('PatientProfileService.getOwn', () => {
  it('derives age instead of reading a stored one', async () => {
    const { service } = build();
    const profile = await service.getOwn('patient-1');

    expect(profile.dateOfBirth).toBe('1990-04-17');
    expect(profile.age).toBe(ageToday('1990-04-17'));
    expect(profile).not.toHaveProperty('ageStored');
  });

  it('reports an incomplete profile as incomplete', async () => {
    const { service } = build({
      row: patient({ fullName: null, dateOfBirth: null, status: 'pending' }),
    });
    const profile = await service.getOwn('patient-1');

    expect(profile.isComplete).toBe(false);
    expect(profile.age).toBeNull();
    expect(profile.dateOfBirth).toBeNull();
  });

  it('shows the mobile number, which is the sign-in identifier', async () => {
    const { service } = build();
    expect((await service.getOwn('patient-1')).mobileNumber).toBe('+919876543210');
  });

  it('404s for a patient that does not exist', async () => {
    const { service } = build({ row: null });
    await expect(service.getOwn('nobody')).rejects.toMatchObject({ status: 404 });
  });
});

describe('PatientProfileService.update', () => {
  it('writes only the fields supplied', async () => {
    const { service, update } = build();
    await service.update('patient-1', { preferredLanguage: 'hi' });
    expect(update.mock.calls[0][0].data).toEqual({ preferredLanguage: 'hi' });
  });

  it('trims a name rather than storing the spacing', async () => {
    const { service, update } = build();
    await service.update('patient-1', { fullName: '  Anita Sharma  ' });
    expect(update.mock.calls[0][0].data.fullName).toBe('Anita Sharma');
  });

  it('stores a date of birth as UTC midnight, so the day does not shift', async () => {
    const { service, update } = build();
    await service.update('patient-1', { dateOfBirth: '1990-04-17' });
    expect((update.mock.calls[0][0].data.dateOfBirth as Date).toISOString()).toBe(
      '1990-04-17T00:00:00.000Z',
    );
  });

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['a date in the future', '2099-01-01'],
    ['an implausible age', '1850-01-01'],
  ])('refuses %s', async (_case, dateOfBirth) => {
    const { service, update } = build();
    await expect(service.update('patient-1', { dateOfBirth })).rejects.toMatchObject({
      response: { code: 'INVALID_DATE_OF_BIRTH' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('*** PROMOTION *** completing the profile moves pending to active', async () => {
    const { service, update } = build({
      row: patient({ fullName: null, dateOfBirth: null, status: 'pending' }),
    });
    await service.update('patient-1', { fullName: 'Anita Sharma', dateOfBirth: '1990-04-17' });
    expect(update.mock.calls[0][0].data.status).toBe('active');
  });

  it('does NOT promote while the profile is still half filled in', async () => {
    const { service, update } = build({
      row: patient({ fullName: null, dateOfBirth: null, status: 'pending' }),
    });
    await service.update('patient-1', { fullName: 'Anita Sharma' });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  it('promotes on the edit that supplies the missing half', async () => {
    const { service, update } = build({
      row: patient({ fullName: 'Anita Sharma', dateOfBirth: null, status: 'pending' }),
    });
    await service.update('patient-1', { dateOfBirth: '1990-04-17' });
    expect(update.mock.calls[0][0].data.status).toBe('active');
  });

  it('never demotes an active account whose name is cleared mid-treatment', async () => {
    const { service, update } = build({ row: patient({ status: 'active' }) });
    await service.update('patient-1', { fullName: ' ' });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  it('audits which fields changed, not what they were changed to', async () => {
    const { service, record } = build();
    await service.update('patient-1', { fullName: 'Anita Sharma', dateOfBirth: '1990-04-17' });

    const entry = record.mock.calls[0][0] as { metadata: { fields: string[] } };
    expect(entry.metadata.fields).toEqual(['fullName', 'dateOfBirth']);
    expect(JSON.stringify(entry)).not.toContain('1990-04-17');
    expect(JSON.stringify(entry)).not.toContain('Anita');
  });
});

describe('PatientProfileService.getCardForDoctor', () => {
  it('*** FAILS CLOSED *** refuses while no consultation ties them together', async () => {
    const { service } = build({ treating: false });
    await expect(service.getCardForDoctor('doctor-1', 'patient-1')).rejects.toMatchObject({
      status: 403,
      response: { code: 'FORBIDDEN' },
    });
  });

  it('reads nothing about the patient when refused', async () => {
    const { service, record } = build({ treating: false });
    await expect(service.getCardForDoctor('doctor-1', 'patient-1')).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });

  it('shows initials, age and gender - never the name (FR-9.2)', async () => {
    const { service } = build({ treating: true });
    const card = await service.getCardForDoctor('doctor-1', 'patient-1');

    expect(card).toEqual({
      id: 'patient-1',
      initials: 'AS',
      age: ageToday('1990-04-17'),
      gender: 'female',
      preferredLanguage: 'en',
    });
    expect(card).not.toHaveProperty('fullName');
    expect(card).not.toHaveProperty('mobileNumber');
    expect(card).not.toHaveProperty('dateOfBirth');
  });

  it('records the doctor reading a patient record (SRS 6.7)', async () => {
    const { service, record } = build({ treating: true });
    await service.getCardForDoctor('doctor-1', 'patient-1');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'doctor',
        actorId: 'doctor-1',
        action: 'read',
        entityType: 'patient_profile',
        entityId: 'patient-1',
      }),
    );
  });

  it('asks about this exact doctor and patient pair', async () => {
    const { service, isDoctorTreating } = build({ treating: true });
    await service.getCardForDoctor('doctor-1', 'patient-1');
    expect(isDoctorTreating).toHaveBeenCalledWith('doctor-1', 'patient-1');
  });
});

/** Recomputed here rather than hard-coded, so the suite does not rot on a birthday. */
function ageToday(iso: string): number {
  const dob = new Date(`${iso}T00:00:00.000Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const delta = now.getUTCMonth() - dob.getUTCMonth();
  if (delta < 0 || (delta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

describe('PatientProfileService region (FR-20.10)', () => {
  it('checks the region is still offered before storing it as a preference', async () => {
    const { service, assertUsable, update } = build();
    await service.update('patient-1', { regionId: 'region-1' });

    expect(assertUsable).toHaveBeenCalledWith('region-1');
    expect(update.mock.calls[0][0].data).toEqual({ regionId: 'region-1' });
  });

  it('refuses a retired region rather than matching on an empty pool', async () => {
    const { service, update } = build({ regionUsable: false });
    await expect(service.update('patient-1', { regionId: 'gone' })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not ask about a region when the edit does not touch one', async () => {
    const { service, assertUsable } = build();
    await service.update('patient-1', { preferredLanguage: 'hi' });
    expect(assertUsable).not.toHaveBeenCalled();
  });
});

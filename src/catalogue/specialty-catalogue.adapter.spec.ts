import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { BASELINE_REQUIRED_DOCUMENTS } from '../doctors/specialty-catalogue';
import { DatabaseSpecialtyCatalogue } from './specialty-catalogue.adapter';

type Row = Record<string, unknown>;

const specialty = (over: Row = {}) => ({
  isActive: true,
  canPrescribe: true,
  consultationFeeInr: 800,
  requiredDocuments: [],
  ...over,
});

function build(over: { row?: Row | null; baseline?: string[] } = {}) {
  const findUnique = vi.fn().mockResolvedValue(over.row === undefined ? specialty() : over.row);
  const prisma = { specialty: { findUnique } } as unknown as PrismaService;
  const get = vi.fn().mockResolvedValue(over.baseline);
  const config = { get } as unknown as AppConfigService;
  return { catalogue: new DatabaseSpecialtyCatalogue(prisma, config), findUnique };
}

describe('DatabaseSpecialtyCatalogue.requiredDocuments', () => {
  it('*** THE BASELINE IS A FLOOR *** an empty specialty list still demands it', async () => {
    // Otherwise an admin could create a specialty asking for nothing, and then
    // verify a provider who had uploaded nothing at all.
    const { catalogue } = build({ row: specialty({ requiredDocuments: [] }) });
    await expect(catalogue.requiredDocuments('specialty-1')).resolves.toEqual(
      BASELINE_REQUIRED_DOCUMENTS,
    );
  });

  it('adds what the specialty asks for on top of the baseline', async () => {
    const { catalogue } = build({
      row: specialty({ requiredDocuments: ['experience_letter'] }),
    });
    const required = await catalogue.requiredDocuments('specialty-1');

    for (const document of BASELINE_REQUIRED_DOCUMENTS) expect(required).toContain(document);
    expect(required).toContain('experience_letter');
  });

  it('never lists a document twice when the specialty repeats the baseline', async () => {
    const { catalogue } = build({
      row: specialty({ requiredDocuments: ['degree_certificate', 'degree_certificate'] }),
    });
    const required = await catalogue.requiredDocuments('specialty-1');
    expect(new Set(required).size).toBe(required.length);
  });

  it('demands the baseline from a provider with no specialty set', async () => {
    const { catalogue, findUnique } = build();
    await expect(catalogue.requiredDocuments(null)).resolves.toEqual(BASELINE_REQUIRED_DOCUMENTS);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('ignores junk in the stored list rather than demanding it', async () => {
    const { catalogue } = build({
      row: specialty({ requiredDocuments: ['not_a_document_type', 42, null] }),
    });
    await expect(catalogue.requiredDocuments('specialty-1')).resolves.toEqual(
      BASELINE_REQUIRED_DOCUMENTS,
    );
  });

  it('honours an admin-edited baseline', async () => {
    const { catalogue } = build({
      baseline: ['identity_proof'],
      row: specialty({ requiredDocuments: [] }),
    });
    await expect(catalogue.requiredDocuments('specialty-1')).resolves.toEqual(['identity_proof']);
  });
});

describe('DatabaseSpecialtyCatalogue.canPrescribe', () => {
  it('reads the specialty', async () => {
    const { catalogue } = build();
    await expect(catalogue.canPrescribe('specialty-1')).resolves.toBe(true);
  });

  it('refuses a provider with no specialty - the permission comes from the service', async () => {
    const { catalogue } = build();
    await expect(catalogue.canPrescribe(null)).resolves.toBe(false);
  });

  it('refuses once the specialty is taken out of service', async () => {
    // Retiring a service must not leave its prescribing right standing.
    const { catalogue } = build({ row: specialty({ isActive: false }) });
    await expect(catalogue.canPrescribe('specialty-1')).resolves.toBe(false);
  });

  it('refuses a specialty that no longer exists', async () => {
    const { catalogue } = build({ row: null });
    await expect(catalogue.canPrescribe('gone')).resolves.toBe(false);
  });
});

describe('DatabaseSpecialtyCatalogue.patientFeeInr', () => {
  it('is the SERVICE price, not the provider payout', async () => {
    const { catalogue } = build({ row: specialty({ consultationFeeInr: 950 }) });
    await expect(catalogue.patientFeeInr('specialty-1')).resolves.toBe(950);
  });

  it('is null where there is no service to price', async () => {
    const { catalogue } = build();
    await expect(catalogue.patientFeeInr(null)).resolves.toBeNull();
  });
});

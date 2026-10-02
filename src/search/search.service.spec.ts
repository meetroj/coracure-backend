import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { ConcernRecord, ConcernsService } from '../catalogue/concerns.service';
import { ServiceListing, SpecialtiesService } from '../catalogue/specialties.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { QueryAssist } from './query-assist';
import { SearchService } from './search.service';

const PSYCHIATRY: ServiceListing = {
  id: 'specialty-psychiatry',
  code: 'psychiatry',
  name: 'Psychiatry',
  description: null,
  consultationFeeInr: 800,
  providerType: 'doctor',
  canPrescribe: true,
};
const COUNSELLING: ServiceListing = {
  id: 'specialty-counselling',
  code: 'counselling',
  name: 'Counselling',
  description: null,
  consultationFeeInr: 500,
  providerType: 'non_doctor',
  canPrescribe: false,
};

const concern = (code: string, specialtyId: string, matchPhrases: string[]): ConcernRecord => ({
  id: `concern-${code}`,
  specialtyId,
  code,
  name: code,
  matchPhrases,
  matchWeight: 1,
  isActive: true,
});

const TAXONOMY = [
  concern('sleep', PSYCHIATRY.id, ['cannot sleep', 'neend nahi aati']),
  concern('anxiety', PSYCHIATRY.id, ['ghabrahat', 'panic']),
  concern('grief', COUNSELLING.id, ['bereavement', 'lost someone']),
];

const SOON = new Date('2026-09-14T09:30:00.000Z');

function build(
  over: { assistCodes?: string[]; soonest?: Date | null; config?: Record<string, unknown> } = {},
) {
  const get = vi
    .fn<(key: string) => Promise<unknown>>()
    .mockImplementation((key) => Promise.resolve(over.config?.[key]));
  const config = { get } as unknown as AppConfigService;

  const concerns = {
    matchTable: vi.fn<() => Promise<ConcernRecord[]>>().mockResolvedValue(TAXONOMY),
    list: vi.fn<() => Promise<ConcernRecord[]>>().mockResolvedValue(TAXONOMY),
  } as unknown as ConcernsService;

  const specialties = {
    listServices: vi
      .fn<() => Promise<ServiceListing[]>>()
      .mockResolvedValue([PSYCHIATRY, COUNSELLING]),
  } as unknown as SpecialtiesService;

  const soonestForPool = vi
    .fn<(filter: { specialtyId?: string }, from: Date) => Promise<Date | null>>()
    .mockResolvedValue(over.soonest === undefined ? SOON : over.soonest);
  const scheduling = { soonestForPool } as unknown as SchedulingService;

  const suggest = vi
    .fn<(query: string, catalogue: unknown[]) => Promise<string[]>>()
    .mockResolvedValue(over.assistCodes ?? []);
  const assist: QueryAssist = { suggest };

  return {
    service: new SearchService(config, concerns, specialties, scheduling, assist),
    soonestForPool,
    suggest,
  };
}

describe('SearchService', () => {
  // -- The crisis guardrail -------------------------------------------------

  it('returns guidance INSTEAD of results on crisis language (FR-5.6)', async () => {
    const { service } = build();
    const response = await service.search('i want to end it all');

    expect(response.crisis).toBe(true);
    // Not "guidance as well as results". A patient in crisis must not be able
    // to scroll past the help to the booking flow.
    expect(response.results).toEqual([]);
    if (response.crisis) {
      expect(response.guidance.helplines.length).toBeGreaterThan(0);
      expect(response.guidance.title).toBeTruthy();
    }
  });

  it('checks for crisis before it matches anything', async () => {
    // The safety property: no failure in matching, the catalogue or the
    // assistant can route around the guardrail, because none of them has run.
    const { service, soonestForPool, suggest } = build();
    await service.search('i cannot sleep and i want to die');

    expect(soonestForPool).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('uses the admin’s crisis list over the one that shipped', async () => {
    const { service } = build({ config: { 'search.crisis_keywords': ['sab khatam'] } });
    expect((await service.search('sab khatam karna hai')).crisis).toBe(true);
    // And the shipped phrases no longer fire, because the list is a replacement.
    expect((await service.search('i want to die')).crisis).toBe(false);
  });

  // -- Results are services, never people -----------------------------------

  it('returns a SERVICE with its fee and the soonest the POOL can cover it', async () => {
    const { service } = build();
    const response = await service.search('i cannot sleep');

    expect(response.results).toHaveLength(1);
    const [result] = response.results;
    expect(result.name).toBe('Psychiatry');
    expect(result.consultationFeeInr).toBe(800);
    expect(result.soonestAvailableAt).toEqual(SOON);
    expect(result.reason).toContain('matched to:');
    // Nothing here names a provider, and nothing carries one's own fee.
    expect(JSON.stringify(result)).not.toContain('doctor-');
  });

  it('asks the scheduler by service, never seeing the roster', async () => {
    // MODULES: M-05 is not a dependency of M-09. The pool is resolved inside
    // M-07, so this module names a specialty and gets a time back.
    const { service, soonestForPool } = build();
    await service.search('i cannot sleep');
    expect(soonestForPool.mock.calls[0][0]).toEqual({ specialtyId: PSYCHIATRY.id });
  });

  it('collapses several concerns of one service into a single result', async () => {
    // Offering the same service three times is three ways to say one thing.
    const { service } = build();
    const response = await service.search('neend nahi aati aur ghabrahat hoti hai');

    expect(response.results).toHaveLength(1);
    expect(response.results[0].concerns.map((c) => c.code).sort()).toEqual(['anxiety', 'sleep']);
  });

  it('returns both services when a query spans them', async () => {
    const { service } = build();
    const response = await service.search('cannot sleep since i lost someone');
    expect(response.results.map((result) => result.code).sort()).toEqual([
      'counselling',
      'psychiatry',
    ]);
  });

  it('says nothing is available rather than inventing a time', async () => {
    const { service } = build({ soonest: null });
    const [result] = (await service.search('i cannot sleep')).results;
    expect(result.soonestAvailableAt).toBeNull();
  });

  it('carries the FR-5.8 disclaimer on every response', async () => {
    // Returned rather than left to the app: a rule that only holds while a
    // client renders it correctly is not a rule the platform is keeping.
    const { service } = build();
    for (const query of ['i cannot sleep', 'i want to die', 'nothing matches this']) {
      expect((await service.search(query)).disclaimer).toMatch(/does not screen, diagnose/);
    }
  });

  // -- The assistant --------------------------------------------------------

  it('does not consult the assistant when the approved mapping has an answer', async () => {
    // A model does not get to reorder clinically reviewed content.
    const { service, suggest } = build({ assistCodes: ['grief'] });
    const response = await service.search('i cannot sleep');

    expect(suggest).not.toHaveBeenCalled();
    expect(response.results[0].matchedBy).toBe('mapping');
  });

  it('consults it only when the mapping found nothing', async () => {
    const { service, suggest } = build({ assistCodes: ['grief'] });
    const response = await service.search('my father passed away recently');

    expect(suggest).toHaveBeenCalled();
    expect(response.results[0].code).toBe('counselling');
    // Labelled, so a reader can tell an approved match from a suggested one.
    expect(response.results[0].matchedBy).toBe('assistant');
  });

  it('drops a code the assistant invented', async () => {
    // The cage: the model is choosing from a menu, not writing one.
    const { service } = build({ assistCodes: ['not_a_real_concern'] });
    expect((await service.search('unmatched wording here')).results).toEqual([]);
  });

  it('returns an empty result set when nothing places the query', async () => {
    const { service } = build();
    const response = await service.search('i need a plumber');
    expect(response.results).toEqual([]);
    expect(response.crisis).toBe(false);
  });

  // -- The guide and suggestions --------------------------------------------

  it('offers every service with its concerns for the unsure (FR-5.5)', async () => {
    const { service } = build();
    const guide = await service.guide();

    expect(guide.services.map((entry) => entry.code)).toEqual(['psychiatry', 'counselling']);
    expect(guide.services[0].concerns.map((c) => c.code).sort()).toEqual(['anxiety', 'sleep']);
    expect(guide.services[0].soonestAvailableAt).toEqual(SOON);
  });

  it('offers popular searches, and nothing recent (FR-5.11)', async () => {
    // Recent searches live on the device. An endpoint returning them would mean
    // the server had been keeping them after all.
    const { service } = build();
    const suggestions = await service.suggestions();

    expect(suggestions.popular.length).toBeGreaterThan(0);
    expect(suggestions).not.toHaveProperty('recent');
  });

  it('lets an admin change the popular list with no release (FR-5.7)', async () => {
    const { service } = build({ config: { 'search.popular_searches': ['exam stress'] } });
    expect((await service.suggestions()).popular).toEqual(['exam stress']);
  });

  it('lets an admin add a synonym that changes what a query matches', async () => {
    // The done-when: "an admin edit changes behaviour with no release".
    const before = build();
    expect((await before.service.search('bura lagta hai')).results).toEqual([]);

    const after = build({ config: { 'search.synonyms': { 'bura lagta hai': ['cannot sleep'] } } });
    const response = await after.service.search('bura lagta hai');
    expect(response.results[0]?.code).toBe('psychiatry');
  });
});

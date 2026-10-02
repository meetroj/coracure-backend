import { describe, expect, it } from 'vitest';

import { ConcernRecord } from '../catalogue/concerns.service';
import { rankConcerns, reasonFor } from './matching';

const concern = (over: Partial<ConcernRecord> & { code: string }): ConcernRecord => ({
  id: `concern-${over.code}`,
  specialtyId: 'psychiatry',
  name: over.code,
  matchPhrases: [],
  matchWeight: 1,
  isActive: true,
  ...over,
});

const SLEEP = concern({
  code: 'sleep',
  name: 'Sleep',
  matchPhrases: [
    'cannot sleep',
    'trouble sleeping',
    'insomnia',
    'neend nahi aati',
    'नींद नहीं आती',
  ],
});
const ANXIETY = concern({
  code: 'anxiety',
  name: 'Anxiety',
  matchPhrases: ['panic', 'constant worry', 'ghabrahat'],
});
const DEPRESSION = concern({
  code: 'depression',
  name: 'Depression',
  matchPhrases: ['feeling low', 'no interest in anything'],
});

const TAXONOMY = [SLEEP, ANXIETY, DEPRESSION];
const SYNONYMS = { neend: ['sleep'], ghabrahat: ['anxiety', 'panic'] };

const codes = (query: string, synonyms = SYNONYMS) =>
  rankConcerns(query, TAXONOMY, synonyms).map((match) => match.concern.code);

describe('rankConcerns', () => {
  it('places a plain English query', () => {
    expect(codes('i cannot sleep')).toEqual(['sleep']);
  });

  it('places a Hinglish query on the same concern', () => {
    // FR-5.1: the same problem typed three ways has to reach one service.
    expect(codes('neend nahi aati')).toEqual(['sleep']);
  });

  it('places a Devanagari query on the same concern', () => {
    expect(codes('मुझे नींद नहीं आती')).toEqual(['sleep']);
  });

  it('places a MIXED Hindi-English query on both concerns it names', () => {
    // The module's done-when: "a mixed-language query returns explained matches".
    const ranked = rankConcerns('neend nahi aati aur ghabrahat hoti hai', TAXONOMY, SYNONYMS);
    expect(ranked.map((match) => match.concern.code).sort()).toEqual(['anxiety', 'sleep']);
    expect(ranked.every((match) => match.matchedPhrases.length > 0)).toBe(true);
  });

  it('matches the concern’s own name, before anyone has written a phrase', () => {
    const bare = [concern({ code: 'grief', name: 'Grief' })];
    expect(rankConcerns('i need help with grief', bare, {})).toHaveLength(1);
  });

  it('ranks a specific phrase above a vague one', () => {
    // "sleep" alone also appears in the Sleep concern's name; the long phrase
    // is what the patient actually said, and it must win.
    const vague = concern({ code: 'general', name: 'sleep' });
    const ranked = rankConcerns('i cannot sleep', [vague, SLEEP], {});
    expect(ranked[0].concern.code).toBe('sleep');
  });

  it('lets match weight be the client’s thumb on the scale', () => {
    const heavier = { ...ANXIETY, matchWeight: 5 };
    const [top] = rankConcerns(
      'worry',
      [
        { ...SLEEP, matchPhrases: ['worry'] },
        { ...heavier, matchPhrases: ['worry'] },
      ],
      {},
    );
    expect(top.concern.code).toBe('anxiety');
  });

  it('returns nothing for a query it cannot place, rather than a guess', () => {
    expect(codes('i need a plumber')).toEqual([]);
    expect(codes('')).toEqual([]);
  });

  it('reports the phrases as WRITTEN, for the reason shown to the patient', () => {
    const [match] = rankConcerns('i have trouble sleeping', TAXONOMY, SYNONYMS);
    expect(match.matchedPhrases).toContain('trouble sleeping');
  });

  it('breaks a score tie by name, so the order is never arbitrary', () => {
    const a = concern({ code: 'b', name: 'Beta', matchPhrases: ['same'] });
    const b = concern({ code: 'a', name: 'Alpha', matchPhrases: ['same'] });
    expect(rankConcerns('same', [a, b], {}).map((m) => m.concern.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('reasonFor', () => {
  it('reads as FR-5.4 asks', () => {
    expect(reasonFor(['sleep', 'anxiety'])).toBe('matched to: sleep, anxiety');
  });

  it('stops at three, so it stays an explanation', () => {
    expect(reasonFor(['a', 'b', 'c', 'd', 'e'])).toBe('matched to: a, b, c');
  });
});

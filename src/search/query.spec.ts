import { describe, expect, it } from 'vitest';

import { containsPhrase, normalise, phraseScore, queryVariants, tokenise } from './query';

describe('normalise', () => {
  it('folds case and strips punctuation', () => {
    expect(normalise("I can't SLEEP, at all!")).toBe('i can t sleep at all');
  });

  it('strips Latin accents', () => {
    expect(normalise('anxiété')).toBe('anxiete');
  });

  it('leaves Devanagari matras alone', () => {
    // The one mistake that would make Hindi search look broken while English
    // kept working: treating combining marks as punctuation turns नींद into
    // न द, which matches nothing.
    expect(normalise('नींद')).toBe('नींद');
    expect(normalise('मुझे नींद नहीं आती।')).toBe('मुझे नींद नहीं आती');
  });

  it('collapses whitespace and handles an empty query', () => {
    expect(normalise('  sleep    problem  ')).toBe('sleep problem');
    expect(tokenise('   !!!   ')).toEqual([]);
  });

  it('keeps digits, which carry meaning in a query', () => {
    expect(tokenise('awake for 3 nights')).toEqual(['awake', 'for', '3', 'nights']);
  });
});

describe('queryVariants', () => {
  const readings = (query: string, synonyms: Record<string, string[]>) =>
    queryVariants(query, synonyms).map((tokens) => tokens.join(' '));

  it('keeps the patient’s own wording as the first reading', () => {
    // A concern phrased in the patient's own words is the one most likely to be
    // there, so a rewrite adds a reading rather than replacing one.
    expect(readings('neend nahi aati', { neend: ['sleep'] })[0]).toBe('neend nahi aati');
  });

  it('rewrites one word into another', () => {
    expect(readings('neend nahi aati', { neend: ['sleep'] })).toContain('sleep nahi aati');
  });

  it('reads the table in both directions', () => {
    // An admin should not have to think about which side of the colon a word
    // belongs on.
    expect(readings('cannot sleep', { neend: ['sleep'] })).toContain('cannot neend');
  });

  it('rewrites ONE word into TWO', () => {
    // Per-word substitution cannot express this: one position would have to
    // hold two words, and a phrase needing them consecutively would never match.
    expect(readings('main udaas hoon', { udaas: ['low mood'] })).toContain('main low mood hoon');
  });

  it('rewrites a MULTI-WORD phrase into another', () => {
    expect(readings('bura lagta hai', { 'bura lagta hai': ['feeling low'] })).toContain(
      'feeling low',
    );
  });

  it('replaces every occurrence in a reading, not just the first', () => {
    expect(readings('neend aur neend', { neend: ['sleep'] })).toContain('sleep aur sleep');
  });

  it('leaves a query with no applicable entry as itself', () => {
    expect(readings('headache', { neend: ['sleep'] })).toEqual(['headache']);
  });

  it('normalises both sides of the table', () => {
    expect(readings('anxiete', { Anxiété: ['ANXIETY'] })).toContain('anxiety');
  });

  it('does not chain one rewrite into another', () => {
    // `a -> b -> c` would drift a query into wording nobody wrote, and each hop
    // is a chance to change what the patient meant.
    expect(readings('a', { a: ['b'], b: ['c'] })).not.toContain('c');
  });

  it('applies every applicable pair at once, for a sentence that needs two', () => {
    // "neend aur ghabrahat" has to have a reading in which BOTH are translated,
    // or a concern phrase spanning the two could never match.
    expect(readings('neend aur ghabrahat', { neend: ['sleep'], ghabrahat: ['anxiety'] })).toContain(
      'sleep aur anxiety',
    );
  });

  it('prefers the longest matching entry when two overlap', () => {
    const readings2 = readings('bura lagta hai', {
      bura: ['bad'],
      'bura lagta hai': ['feeling low'],
    });
    expect(readings2).toContain('feeling low');
  });

  it('caps how many readings one query can grow', () => {
    const thesaurus = Object.fromEntries(
      Array.from({ length: 60 }, (_value, index) => [`w${index}`, [`x${index}`]]),
    );
    const query = Array.from({ length: 40 }, (_value, index) => `w${index}`).join(' ');
    expect(queryVariants(query, thesaurus).length).toBeLessThanOrEqual(24);
  });

  it('is empty for a query with no words at all', () => {
    expect(queryVariants('!!! ???', {})).toEqual([]);
  });
});

describe('containsPhrase', () => {
  const variants = queryVariants('i cannot sleep at night', {});

  it('finds a phrase as a run of consecutive words', () => {
    expect(containsPhrase(variants, tokenise('cannot sleep'))).toBe(true);
    expect(containsPhrase(variants, tokenise('sleep at night'))).toBe(true);
  });

  it('will not match words scattered across the query', () => {
    // "sleep" and "night" at opposite ends of a sentence is not the phrase
    // "night sleep", and treating it as one is how a search starts matching
    // everything to everything.
    expect(containsPhrase(variants, tokenise('night sleep'))).toBe(false);
  });

  it('matches through a rewritten reading', () => {
    const hinglish = queryVariants('neend nahi aati', { neend: ['sleep'] });
    expect(containsPhrase(hinglish, tokenise('sleep'))).toBe(true);
  });

  it('matches a two-word phrase a one-word synonym expanded into', () => {
    const expanded = queryVariants('main udaas hoon', { udaas: ['low mood'] });
    expect(containsPhrase(expanded, tokenise('low mood'))).toBe(true);
  });

  it('is false for a phrase longer than the query, and for an empty one', () => {
    expect(containsPhrase(queryVariants('sleep', {}), tokenise('cannot sleep at all'))).toBe(false);
    expect(containsPhrase(variants, [])).toBe(false);
  });
});

describe('phraseScore', () => {
  it('grows faster than length, so specificity beats accumulation', () => {
    // Three one-word matches must not outrank one four-word match: the long
    // phrase is the one the patient actually said.
    expect(phraseScore(tokenise('sleep')) * 3).toBeLessThan(
      phraseScore(tokenise('cannot sleep at night')),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { CRISIS_KEYWORDS, SYNONYMS } from './search.config';
import { detectCrisis } from './crisis';

const fires = (query: string) => detectCrisis(query, CRISIS_KEYWORDS, SYNONYMS);

describe('the crisis guardrail', () => {
  it.each([
    'i want to die',
    'I WANT TO DIE',
    'thinking about suicide',
    'i have been thinking of killing myself lately',
    'i want to end it all',
    'no reason to live anymore',
    'i keep cutting myself',
    "there's no point, i'd be better off dead",
  ])('fires on %j', (query) => {
    expect(fires(query)).toBe(true);
  });

  it.each([
    'khudkushi ka khayal aata hai',
    'main marna chahta hoon',
    'mujhe lagta hai mar jaunga',
    'आत्महत्या के विचार आते हैं',
    'मैं मरना चाहता हूं',
  ])('fires on Hindi and Hinglish: %j', (query) => {
    // FR-5.1 accepts English, Hindi and mixed input, and the guardrail has to
    // cover every language the search box does - a guardrail that only reads
    // English is one that misses the patients least likely to type in it.
    expect(fires(query)).toBe(true);
  });

  it.each([
    'trouble sleeping',
    'i feel low and tired',
    'my diet has been poor',
    'exam stress',
    'my father died last year and i am struggling',
    'panic attacks at work',
    'neend nahi aati',
  ])('stays quiet on %j', (query) => {
    expect(fires(query)).toBe(false);
  });

  it('will not fire on a word that merely contains a keyword', () => {
    // `die` inside `diet`. A guardrail that cries wolf is one an operator
    // eventually turns off, which is the worst outcome available.
    expect(detectCrisis('changing my diet', ['die'])).toBe(false);
    expect(detectCrisis('i want to die', ['die'])).toBe(true);
  });

  it('needs the words of a phrase together and in order', () => {
    expect(detectCrisis('the end of it was all fine', ['end it all'])).toBe(false);
    expect(detectCrisis('i want to end it all', ['end it all'])).toBe(true);
  });

  it('ignores punctuation and spacing the way the search does', () => {
    expect(detectCrisis('KILL   MYSELF!!!', ['kill myself'])).toBe(true);
  });

  it('is quiet on an empty or wordless query', () => {
    expect(detectCrisis('', CRISIS_KEYWORDS)).toBe(false);
    expect(detectCrisis('!!! ???', CRISIS_KEYWORDS)).toBe(false);
  });

  it('never fires when the list has been emptied, which is why that is dangerous', () => {
    // Recorded as a fact rather than a feature: an admin who clears the list has
    // switched the guardrail off, and the config description says so.
    expect(detectCrisis('i want to die', [])).toBe(false);
  });

  it('ships a list with no phrase so short it would fire on ordinary text', () => {
    // A one-word keyword like "end" or "cut" would make the guardrail unusable.
    for (const keyword of CRISIS_KEYWORDS) {
      expect(keyword.trim().length, keyword).toBeGreaterThanOrEqual(6);
    }
  });
});

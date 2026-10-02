import { describe, expect, it } from 'vitest';

import { describe as describeFindings, findIdentifiers, scanCase } from './deidentify';

const kinds = (text: string) => findIdentifiers('briefHistory', text).map((item) => item.kind);

/**
 * *** M-17 IS DONE WHEN NO SHARED CASE HOLDS A DIRECT IDENTIFIER. ***
 *
 * The columns get most of the way there — there is nowhere in
 * `clarification_cases` to put a name, a phone, an address or an email. What
 * the schema cannot reach is the free text, and this is that.
 */
describe('finding identifiers in free text (FR-12.2)', () => {
  it.each([
    ['a plain mobile number', 'Patient keeps calling on 9876543210 at night.'],
    ['a spaced mobile number', 'Reachable on 98765 43210 most evenings.'],
    ['a hyphenated mobile number', 'Contact 98765-43210 if needed.'],
    ['a number with a country code', 'Best number is +91 9876543210.'],
  ])('catches %s', (_case, text) => {
    expect(kinds(text)).toContain('phone');
  });

  it('catches an email address', () => {
    expect(kinds('They email me at ranjan.k@example.com every day.')).toContain('email');
  });

  it('catches a link, which is a way to hand over a record held elsewhere', () => {
    expect(kinds('Old notes at https://records.example.org/p/8891')).toContain('url');
    expect(kinds('See www.example.org/patient/x for the scans.')).toContain('url');
  });

  it('catches an Aadhaar-shaped number', () => {
    expect(kinds('ID 1234 5678 9012 on file.')).toContain('aadhaar');
  });

  /**
   * Deliberately vague, and deliberately last. Hospital numbers, insurance ids
   * and record numbers have no single national format, so a long run of digits
   * is the only handle there is — at the cost of occasionally catching
   * something innocent, which the author can rephrase in seconds.
   */
  it('catches a long unexplained number', () => {
    expect(kinds('Hospital record 448192037 from the earlier admission.')).toContain('long_digits');
  });

  /**
   * One match, reported once. An Aadhaar number is twelve digits and would
   * otherwise be reported again as a long run of digits — telling the author to
   * remove two things when there is one.
   */
  it('claims each match once, so nothing is reported twice', () => {
    const found = findIdentifiers('briefHistory', 'ID 1234 5678 9012 on file.');
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('aadhaar');
  });

  /**
   * *** THE SAMPLE MUST NOT BE THE IDENTIFIER. *** It goes into an error body
   * and a log line; echoing the number back would put it in two more places
   * than it was, which is the opposite of the point.
   */
  it('never echoes the identifier back in full', () => {
    const [found] = findIdentifiers('briefHistory', 'Call 9876543210 please.');
    expect(found?.sample).not.toContain('9876543210');
    expect(found?.sample).toBe('987…10');
  });
});

/**
 * A scanner that fires on ordinary clinical prose trains people to click past
 * it, and a warning people click past protects nobody. These are the sentences
 * a psychiatrist writes all day.
 */
describe('leaving ordinary clinical prose alone', () => {
  it.each([
    'Sleeping 4 to 5 hours, waking at 3am.',
    'Started sertraline 50mg, increased to 100mg after 2 weeks.',
    'Third episode in 6 years; last admission was in 2019.',
    'PHQ-9 score 18, GAD-7 score 14.',
    'Reports mood worse on Sunday and Monday.',
    'Seen twice, on 12 March and 26 March.',
    'BP 130/85, weight 72kg.',
    'Family history of bipolar disorder in a first-degree relative.',
  ])('does not fire on %o', (text) => {
    expect(findIdentifiers('briefHistory', text)).toEqual([]);
  });

  /** A dose is not an identifier, however many digits a schedule has. */
  it('does not fire on a medication schedule', () => {
    expect(findIdentifiers('currentPlan', 'Olanzapine 5mg at night, review in 2 weeks.')).toEqual(
      [],
    );
  });
});

describe('scanning a whole case', () => {
  it('names which field the identifier was in', () => {
    const found = scanCase({
      title: 'Low mood, poor response',
      briefHistory: 'Contactable on 9876543210.',
      specificDoubt: 'Would you switch or augment?',
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe('briefHistory');
  });

  it('finds identifiers across several fields at once', () => {
    const found = scanCase({
      briefHistory: 'Reachable on 9876543210.',
      specificDoubt: 'I emailed the notes to k.sharma@example.com — is that plan right?',
    });
    expect(found.map((item) => item.field).sort()).toEqual(['briefHistory', 'specificDoubt']);
  });

  it('says nothing about a clean case', () => {
    expect(
      scanCase({
        title: 'Treatment-resistant depression',
        briefHistory: '34-year-old, two adequate SSRI trials, partial response.',
        diagnosis: 'Recurrent depressive disorder, current episode moderate',
        currentPlan: 'Sertraline 150mg daily, weekly CBT',
        specificDoubt: 'Augment with an atypical, or switch class?',
      }),
    ).toEqual([]);
  });

  it('tells the author what to take out, without repeating it', () => {
    const message = describeFindings(scanCase({ briefHistory: 'Call 9876543210 or mail a@b.co' }));
    expect(message).toContain('a phone number');
    expect(message).toContain('an email address');
    expect(message).not.toContain('9876543210');
  });
});

/**
 * The regexes are module-level and global, so `lastIndex` survives between
 * calls unless it is reset. That is exactly the bug that shows up as one case
 * in fifty scanning clean — and a safety scanner that works most of the time is
 * worse than none, because it is trusted.
 */
describe('scanning repeatedly', () => {
  it('gives the same answer every time', () => {
    const text = 'Patient rings on 9876543210 daily.';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(kinds(text)).toContain('phone');
    }
  });

  it('does not let one case leak state into the next', () => {
    expect(kinds('Call 9876543210.')).toContain('phone');
    expect(findIdentifiers('briefHistory', 'Sleeping poorly, no other concerns.')).toEqual([]);
    expect(kinds('Call 9876543210.')).toContain('phone');
  });
});

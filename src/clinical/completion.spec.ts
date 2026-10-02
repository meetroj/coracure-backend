import { describe, expect, it } from 'vitest';

import { Completable, caseSummaryLines, hasAdvicePlan, outstandingFor } from './completion';

const PRESCRIBING = true;
const NOT_PRESCRIBING = false;

const SUMMARY = ['Presented with low mood.', 'Started on an SSRI.', 'Review in four weeks.'].join(
  '\n',
);

const record = (over: Partial<Completable> = {}): Completable => ({
  caseSummary: SUMMARY,
  medicines: [],
  adviceCovered: 'Discussed sleep hygiene and activity scheduling.',
  ...over,
});

const codes = (record: Completable, canPrescribe: boolean) =>
  outstandingFor(record, canPrescribe).map((item) => item.code);

describe('the case summary (FR-11.3)', () => {
  it('counts non-blank lines, so paragraph spacing is not content', () => {
    expect(caseSummaryLines('one\n\ntwo\n   \nthree')).toHaveLength(3);
  });

  it('is required', () => {
    expect(codes(record({ caseSummary: null }), PRESCRIBING)).toContain('CASE_SUMMARY_MISSING');
    expect(codes(record({ caseSummary: '   \n  ' }), PRESCRIBING)).toContain(
      'CASE_SUMMARY_MISSING',
    );
  });

  /**
   * The floor is the point of the rule. A one-line summary is not a handover,
   * and the next clinician to open this case gets nothing from it.
   */
  it('needs at least three lines', () => {
    expect(codes(record({ caseSummary: 'Seen and treated.' }), PRESCRIBING)).toContain(
      'CASE_SUMMARY_TOO_SHORT',
    );
  });

  /** The ceiling keeps it a SUMMARY rather than the notes written twice. */
  it('allows no more than five', () => {
    const six = Array.from({ length: 6 }, (_, i) => `Line ${i + 1}.`).join('\n');
    expect(codes(record({ caseSummary: six }), PRESCRIBING)).toContain('CASE_SUMMARY_TOO_LONG');
  });

  it.each([3, 4, 5])('accepts %i lines', (count) => {
    const summary = Array.from({ length: count }, (_, i) => `Line ${i + 1}.`).join('\n');
    expect(codes(record({ caseSummary: summary }), PRESCRIBING)).toHaveLength(0);
  });
});

/**
 * *** THE RULE M-15 IS JUDGED ON. ***
 * "A consultation cannot be marked complete with a missing prescription or
 * advice and summary."
 */
describe('the closing record (FR-11.5)', () => {
  it('lets a prescribing professional close with a prescription', () => {
    const withMedicine = record({
      medicines: [
        {
          id: 'med-1',
          name: 'Sertraline 50mg',
          dose: '1 tablet',
          frequency: 'Daily',
          duration: '4 weeks',
        },
      ],
      adviceCovered: null,
    });
    expect(outstandingFor(withMedicine, PRESCRIBING)).toHaveLength(0);
  });

  /**
   * Not every consultation ends in medicine. Refusing to close one that ends in
   * "no medication indicated, here is the plan" would push doctors into
   * prescribing something to get the case shut.
   */
  it('lets a prescribing professional close with advice and no medicine at all', () => {
    expect(outstandingFor(record({ medicines: [] }), PRESCRIBING)).toHaveLength(0);
  });

  it('refuses a prescribing professional who wrote neither', () => {
    const empty = record({ medicines: [], adviceCovered: null });
    expect(codes(empty, PRESCRIBING)).toContain('PRESCRIPTION_OR_ADVICE_MISSING');
  });

  /**
   * The advice and therapy plan is the ONLY closing record a non-prescribing
   * professional can write, so there is no branch that lets an empty one
   * through. A medicine cannot stand in for it — and they could not have saved
   * one anyway.
   */
  it('requires the advice plan from a non-prescribing professional', () => {
    const empty = record({ adviceCovered: null });
    expect(codes(empty, NOT_PRESCRIBING)).toContain('ADVICE_MISSING');
  });

  it('accepts any part of the advice plan as the closing record', () => {
    for (const field of [
      'adviceCovered',
      'adviceHomePractice',
      'adviceNextFocus',
      'adviceWarningSigns',
    ] as const) {
      const only = record({ adviceCovered: null, [field]: 'Something written here.' });
      expect(hasAdvicePlan(only)).toBe(true);
      expect(outstandingFor(only, NOT_PRESCRIBING)).toHaveLength(0);
    }
  });

  it('does not treat whitespace as an advice plan', () => {
    expect(hasAdvicePlan(record({ adviceCovered: '   ' }))).toBe(false);
  });

  /** A doctor should see everything outstanding at once, not one thing at a time. */
  it('reports every missing requirement together', () => {
    const nothing: Completable = { medicines: [] };
    expect(codes(nothing, PRESCRIBING)).toEqual([
      'CASE_SUMMARY_MISSING',
      'PRESCRIPTION_OR_ADVICE_MISSING',
    ]);
  });

  it('is empty exactly when the case can be completed', () => {
    expect(outstandingFor(record(), PRESCRIBING)).toEqual([]);
    expect(outstandingFor(record(), NOT_PRESCRIBING)).toEqual([]);
  });
});

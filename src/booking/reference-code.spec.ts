import { describe, expect, it } from 'vitest';

import { generateReferenceCode, looksLikeReferenceCode } from './reference-code';

describe('generateReferenceCode', () => {
  it('is shaped so a patient can read it down a phone line', () => {
    expect(looksLikeReferenceCode(generateReferenceCode())).toBe(true);
  });

  it('contains none of the characters people mishear', () => {
    // 0/O and 1/I/L are the pairs that turn a support call into two calls.
    const codes = Array.from({ length: 400 }, () => generateReferenceCode()).join('');
    for (const character of ['0', 'O', '1', 'I', 'L']) {
      expect(codes).not.toContain(character);
    }
  });

  it('is not sequential', () => {
    // `CC-000173` would tell every patient how many consultations the platform
    // has taken, and would let anyone guess a neighbouring one.
    const codes = new Set(Array.from({ length: 500 }, () => generateReferenceCode()));
    expect(codes.size).toBe(500);
  });

  it('fits the column', () => {
    expect(generateReferenceCode().length).toBeLessThanOrEqual(24);
  });

  it('rejects anything this service could not have minted', () => {
    expect(looksLikeReferenceCode('CC-0000-0000')).toBe(false);
    expect(looksLikeReferenceCode('nonsense')).toBe(false);
  });
});

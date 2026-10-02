import { describe, expect, it } from 'vitest';

import {
  ageFrom,
  formatDateOfBirth,
  initialsOf,
  isPlausibleDateOfBirth,
  parseDateOfBirth,
} from './date-of-birth';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('parseDateOfBirth', () => {
  it('reads a calendar day as UTC midnight, so the day stored is the day entered', () => {
    const parsed = parseDateOfBirth('1990-04-17');
    expect(parsed?.toISOString()).toBe('1990-04-17T00:00:00.000Z');
  });

  it('accepts a real leap day', () => {
    expect(parseDateOfBirth('2000-02-29')?.toISOString()).toBe('2000-02-29T00:00:00.000Z');
  });

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['29 February in a non-leap year', '2001-02-29'],
    ['month 13', '1990-13-01'],
    ['day 00', '1990-01-00'],
    ['the wrong order', '17-04-1990'],
    ['a timestamp', '1990-04-17T00:00:00Z'],
    ['nothing at all', ''],
  ])('refuses %s', (_case, input) => {
    expect(parseDateOfBirth(input)).toBeNull();
  });

  it('round-trips through formatDateOfBirth', () => {
    const parsed = parseDateOfBirth('1985-12-31');
    expect(formatDateOfBirth(parsed as Date)).toBe('1985-12-31');
  });
});

describe('ageFrom', () => {
  it('counts completed years', () => {
    expect(ageFrom(utc('1990-04-17'), utc('2026-08-31'))).toBe(36);
  });

  it('turns over ON the birthday, not before or after', () => {
    expect(ageFrom(utc('1990-04-17'), utc('2026-04-16'))).toBe(35);
    expect(ageFrom(utc('1990-04-17'), utc('2026-04-17'))).toBe(36);
    expect(ageFrom(utc('1990-04-17'), utc('2026-04-18'))).toBe(36);
  });

  it('does not count a birthday later this year', () => {
    expect(ageFrom(utc('1990-12-25'), utc('2026-08-31'))).toBe(35);
  });

  it('ages a 29 February birthday on 1 March in a non-leap year', () => {
    // 2026 has no 29 February. On the 28th they are still 25.
    expect(ageFrom(utc('2000-02-29'), utc('2026-02-28'))).toBe(25);
    expect(ageFrom(utc('2000-02-29'), utc('2026-03-01'))).toBe(26);
    // And in a leap year the actual day works.
    expect(ageFrom(utc('2000-02-29'), utc('2028-02-29'))).toBe(28);
  });

  it('is 0 for a baby born this year', () => {
    expect(ageFrom(utc('2026-01-04'), utc('2026-08-31'))).toBe(0);
  });
});

describe('isPlausibleDateOfBirth', () => {
  it('refuses tomorrow', () => {
    expect(isPlausibleDateOfBirth(utc('2026-09-01'), utc('2026-08-31'))).toBe(false);
  });

  it('accepts today', () => {
    expect(isPlausibleDateOfBirth(utc('2026-08-31'), utc('2026-08-31'))).toBe(true);
  });

  it('refuses an age no one reaches', () => {
    expect(isPlausibleDateOfBirth(utc('1850-01-01'), utc('2026-08-31'))).toBe(false);
  });

  it('accepts a plausibly old patient', () => {
    expect(isPlausibleDateOfBirth(utc('1930-06-02'), utc('2026-08-31'))).toBe(true);
  });
});

describe('initialsOf', () => {
  it('takes the first and last name', () => {
    expect(initialsOf('Anita Sharma')).toBe('AS');
  });

  it('skips middle names rather than making the card ragged', () => {
    expect(initialsOf('Anita Devi Sharma')).toBe('AS');
  });

  it('handles a single name', () => {
    expect(initialsOf('Anita')).toBe('A');
  });

  it('tolerates untidy spacing', () => {
    expect(initialsOf('  anita   sharma  ')).toBe('AS');
  });

  it('handles a non-Latin name by code point, not byte', () => {
    expect(initialsOf('अनीता शर्मा')).toBe('अश');
  });

  it('has nothing to show for a patient who has not given a name', () => {
    expect(initialsOf(null)).toBeNull();
    expect(initialsOf('   ')).toBeNull();
  });
});

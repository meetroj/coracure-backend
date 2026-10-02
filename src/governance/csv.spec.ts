import { describe, expect, it } from 'vitest';

import { cell, csvFilename, toCsv } from './csv';

describe('writing a CSV cell', () => {
  it('quotes everything, so no rule has to be remembered', () => {
    expect(cell('plain')).toBe('"plain"');
    expect(cell(42)).toBe('"42"');
  });

  it('doubles embedded quotes', () => {
    expect(cell('she said "late"')).toBe('"she said ""late"""');
  });

  it('survives a comma and a newline inside a cell', () => {
    expect(cell('late, rushed')).toBe('"late, rushed"');
    expect(cell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes an empty cell for nothing', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });

  it('writes a date as an instant, not as a locale', () => {
    expect(cell(new Date('2026-09-19T10:00:00.000Z'))).toBe('"2026-09-19T10:00:00.000Z"');
  });

  /** `String(anObject)` is `[object Object]`, which in an export reads as data. */
  it('serialises an object rather than stringifying it to nothing', () => {
    expect(cell({ assignedTo: 'admin-1' })).toBe('"{""assignedTo"":""admin-1""}"');
  });
});

/**
 * *** THE FORMULA INJECTION GUARD. ***
 *
 * A cell beginning `=`, `+`, `-` or `@` is EXECUTED as a formula by Excel and
 * Sheets. These exports carry patient-written text — complaint descriptions,
 * feedback comments — so somebody could put a formula in a complaint and have
 * it run on an admin's machine when the file is opened.
 */
describe('the formula injection guard', () => {
  it.each([
    ['=HYPERLINK("http://evil","Click me")', '='],
    ['+1+1', '+'],
    ['-2+3', '-'],
    ['@SUM(A1:A9)', '@'],
  ])('neutralises %o, which starts with %o', (dangerous) => {
    const written = cell(dangerous);
    // A leading apostrophe makes the cell literal text. It is invisible in the
    // spreadsheet and costs nothing.
    expect(written.startsWith(`"'`)).toBe(true);
    // The text itself survives intact - undo the CSV quoting and it is the
    // original, prefixed. Guarding must not mangle what somebody wrote.
    const unquoted = written.slice(1, -1).replace(/""/g, '"');
    expect(unquoted).toBe(`'${dangerous}`);
  });

  it('guards a tab and a carriage return too', () => {
    expect(cell('\tsneaky')).toBe(`"'\tsneaky"`);
  });

  /** Ordinary text must not be mangled, or people stop trusting the export. */
  it.each([
    'Provider joined 20 minutes late',
    'Refunded the convenience fee',
    '4 out of 5',
    'sertraline 150mg',
  ])('leaves ordinary text alone: %o', (text) => {
    expect(cell(text)).toBe(`"${text}"`);
  });

  /** A negative NUMBER is not a formula, but it does start with a hyphen. */
  it('guards a negative number, because a spreadsheet cannot tell them apart', () => {
    expect(cell('-500')).toBe(`"'-500"`);
    // Passed as a number rather than a string it is still guarded, and still
    // reads as -500 in the cell.
    expect(cell(-500)).toBe(`"'-500"`);
  });
});

describe('writing a whole sheet', () => {
  it('uses CRLF, which is what Excel expects', () => {
    const csv = toCsv(['a', 'b'], [[1, 2]]);
    expect(csv).toBe('"a","b"\r\n"1","2"\r\n');
  });

  it('writes a header even with no rows', () => {
    expect(toCsv(['reference', 'status'], [])).toBe('"reference","status"\r\n');
  });

  it('ends with a newline, so a concatenated file is not corrupted', () => {
    expect(toCsv(['a'], [['x']]).endsWith('\r\n')).toBe(true);
  });
});

describe('the filename', () => {
  /** These land in a downloads folder beside last month's. */
  it('is dated, so two exports are tellable apart without opening them', () => {
    expect(csvFilename('complaints', new Date('2026-09-19T10:00:00.000Z'))).toBe(
      'coracure-complaints-2026-09-19.csv',
    );
  });
});

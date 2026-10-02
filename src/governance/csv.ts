/**
 * CSV, written out by hand.
 *
 * A dependency for this would be a dependency for four lines of escaping, and
 * the escaping is the only part that matters. Everything below exists because
 * a governance export lands in a spreadsheet on somebody's desk, and a report
 * that quietly mangles one row is worse than one that fails to open.
 */

/**
 * *** THE FORMULA INJECTION GUARD. ***
 *
 * A cell beginning `=`, `+`, `-` or `@` is executed as a FORMULA by Excel and
 * Sheets when the file is opened. These exports carry patient-written text -
 * complaint descriptions, feedback comments - so somebody could put
 * `=HYPERLINK("http://evil","Click")` in a complaint and have it run on an
 * admin's machine.
 *
 * Prefixing with a single quote makes the cell literal text. It is the standard
 * mitigation, it is invisible in the spreadsheet, and it costs nothing.
 */
const DANGEROUS_LEAD = /^[=+\-@\t\r]/;

/** One cell: injection-guarded, quoted, and with quotes doubled. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // `String(anObject)` is `[object Object]`, which in an export reads as data
  // and is not. Anything that is not a primitive is serialised properly.
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : JSON.stringify(value);

  const guarded = DANGEROUS_LEAD.test(text) ? `'${text}` : text;
  // Always quoted rather than only when it contains a comma. A rule applied
  // sometimes is a rule somebody has to remember; this one applies always.
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * A sheet, from a header row and its rows.
 *
 * CRLF because that is what RFC 4180 says and what Excel expects; a
 * newline-only file opens as one long row in some versions.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * A filename that sorts chronologically and cannot collide.
 *
 * Dated rather than "export.csv", because these end up in a downloads folder
 * beside last month's and the difference has to be visible without opening them.
 */
export function csvFilename(kind: string, at = new Date()): string {
  return `coracure-${kind}-${at.toISOString().slice(0, 10)}.csv`;
}

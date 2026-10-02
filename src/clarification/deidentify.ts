/**
 * *** FR-12.2, FOR THE PART THE SCHEMA CANNOT REACH. ***
 *
 * De-identification here is mostly STRUCTURAL: `clarification_cases` has no
 * column for a name, a phone number, an address or an email, and M-10's CHECK
 * forbids a case attachment from carrying a patient. Neither can be got round
 * by writing the wrong code.
 *
 * What structure cannot reach is the FREE TEXT. `brief_history` and
 * `specific_doubt` are prose written by a busy clinician, and "Mrs Sharma has
 * been calling me on 98765 43210" is one distracted sentence away. M-17 is done
 * when "no shared case holds a direct identifier", and a column that merely has
 * no name in its title does not achieve that on its own.
 *
 * So this scans, and REFUSES rather than redacting. Silently rewriting a
 * clinician's words would be worse than either alternative: they would not know
 * what the expert was actually shown, and a scanner good enough to trust with
 * silent edits does not exist. Telling the author what to take out keeps the
 * decision with the person who knows what the sentence meant.
 *
 * It is deliberately narrow. It catches the mechanical identifiers - the ones
 * with a shape - and does not attempt names, because a name detector that fires
 * on "the patient reports Sunday was worse" trains people to click past it, and
 * a warning people click past protects nobody.
 */

/** What was found, and what to tell the author to remove. */
export interface Identifier {
  kind: 'phone' | 'email' | 'aadhaar' | 'url' | 'long_digits';
  /** The offending text, TRUNCATED. The message goes into an error body. */
  sample: string;
  field: string;
}

/**
 * Indian mobile numbers: ten digits starting 6-9, optionally with a country
 * code, and with separators allowed ANYWHERE rather than at fixed positions.
 *
 * The fixed-position version of this — three digits, three, then four — missed
 * `98765 43210`, which is how the number is most often written by hand. A
 * pattern that catches the tidy form and not the human one is worse than
 * useless here, because it reads as working.
 */
const PHONE = /(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}\b/g;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;

/** Aadhaar: twelve digits, usually grouped in fours. */
const AADHAAR = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

/** A link is a way to hand over a record that lives somewhere else. */
const URL = /\b(?:https?:\/\/|www\.)\S{4,}/gi;

/**
 * Any other long run of digits. Deliberately last and deliberately vague: it
 * catches the hospital numbers, insurance ids and record numbers that have no
 * single national format, at the cost of occasionally catching something
 * innocent - which the author can rephrase in seconds.
 */
const LONG_DIGITS = /\b\d{8,}\b/g;

const PATTERNS: { kind: Identifier['kind']; pattern: RegExp }[] = [
  { kind: 'email', pattern: EMAIL },
  { kind: 'url', pattern: URL },
  { kind: 'aadhaar', pattern: AADHAAR },
  { kind: 'phone', pattern: PHONE },
  { kind: 'long_digits', pattern: LONG_DIGITS },
];

/** Enough to recognise what was matched, never enough to be the identifier. */
function sampleOf(match: string): string {
  const trimmed = match.trim();
  return trimmed.length <= 6 ? trimmed : `${trimmed.slice(0, 3)}…${trimmed.slice(-2)}`;
}

/**
 * Everything identifier-shaped in one field.
 *
 * Ordered by how specific the pattern is, and each match is claimed once: an
 * Aadhaar number is twelve digits and would otherwise be reported again as a
 * long run of digits, which would tell the author to remove two things when
 * there is one.
 */
export function findIdentifiers(field: string, text: string | null | undefined): Identifier[] {
  if (!text) return [];

  const found: Identifier[] = [];
  const claimed: [number, number][] = [];

  for (const { kind, pattern } of PATTERNS) {
    // The regexes are global, so `lastIndex` survives between calls unless it
    // is reset. Sharing module-level state across requests is exactly the kind
    // of bug that shows up as one case in fifty scanning clean.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const overlaps = claimed.some(([from, to]) => start < to && end > from);
      if (overlaps) continue;
      claimed.push([start, end]);
      found.push({ kind, sample: sampleOf(match[0]), field });
    }
  }
  return found;
}

/** Every free-text field of a case, scanned together. */
export function scanCase(fields: Record<string, string | null | undefined>): Identifier[] {
  return Object.entries(fields).flatMap(([field, text]) => findIdentifiers(field, text));
}

/** What the author is told to do about it, per kind. */
export const IDENTIFIER_ADVICE: Record<Identifier['kind'], string> = {
  phone: 'a phone number',
  email: 'an email address',
  aadhaar: 'what looks like an Aadhaar number',
  url: 'a link',
  long_digits: 'a long number, which may be a hospital or insurance identifier',
};

/** One sentence naming what to take out, for the error body. */
export function describe(found: Identifier[]): string {
  const kinds = [...new Set(found.map((item) => IDENTIFIER_ADVICE[item.kind]))];
  return `This case appears to contain ${kinds.join(', ')}. Please take it out — the reviewer must not be able to identify the patient.`;
}

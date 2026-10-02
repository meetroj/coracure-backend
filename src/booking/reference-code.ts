import { randomInt } from 'node:crypto';

/**
 * The consultation reference a patient reads out to support.
 *
 * `consultations.id` is the consultation ID that every record hangs from, but a
 * uuid is not something anybody can quote down a phone line. This is the same
 * row's human handle: short, grouped, and drawn from an alphabet with no 0/O
 * and no 1/I/L, so the two characters people always mishear cannot occur.
 *
 * Not sequential, on purpose. `CC-000173` would tell every patient how many
 * consultations the platform has taken, and would let anyone guess a
 * neighbouring one.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * The prefix says WHICH KIND of thing the code names.
 *
 * A patient on the phone reads out one string; support has to know whether they
 * have been given a consultation or a complaint ticket without asking. Two
 * prefixes over one shared alphabet is what makes that free - and the alphabet
 * is shared precisely so the no-mishearing rule holds for both.
 */
export type ReferencePrefix = 'CC' | 'CX';

export function generateReferenceCode(prefix: ReferencePrefix = 'CC'): string {
  const block = (length: number) =>
    Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${prefix}-${block(4)}-${block(4)}`;
}

/** True for a code this service could have minted. Used to fail fast on a lookup. */
export function looksLikeReferenceCode(value: string, prefix: ReferencePrefix = 'CC'): boolean {
  return new RegExp(`^${prefix}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`).test(value);
}

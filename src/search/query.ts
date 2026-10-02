/**
 * Turning what a patient typed into something matchable.
 *
 * FR-5.1 accepts English, Hindi, or the two mixed, with synonyms and informal
 * phrasing - which in practice means one query can arrive as "can't sleep",
 * "neend nahi aati" or "नींद नहीं आती" and has to reach the same concern.
 *
 * There is no transliteration and no language detection here, deliberately. Both
 * guess, and a guess in this position quietly routes somebody to the wrong
 * service. What the platform does instead is match on whatever forms the CLIENT
 * has supplied - SRS 2.5 makes the mapping theirs - through two layers an admin
 * edits with no release: `concerns.match_phrases` for the taxonomy (M-06), and
 * the synonym table for everything that means the same as something else.
 *
 * Everything here is pure, so the edges can be tested exhaustively.
 */

/** Latin combining accents. Devanagari matras live at U+0900-U+097F and are untouched. */
const LATIN_DIACRITICS = /[̀-ͯ]/g;

/**
 * Anything that is not a letter, a digit or a COMBINING MARK becomes a break.
 *
 * `\p{M}` is the part that is easy to leave out and expensive to leave out. A
 * Devanagari matra is a combining mark, not a letter, so `[^\p{L}\p{N}]` treats
 * the vowel signs in नींद as punctuation and hands back न द - a word that
 * matches nothing, while English carries on working perfectly.
 */
const NON_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * Case-folded, punctuation-stripped, whitespace-collapsed.
 *
 * Accents are removed from Latin text only. Stripping combining marks
 * indiscriminately would take the matras off Devanagari and turn नींद into नद,
 * which matches nothing - the single mistake that would make Hindi search look
 * broken while English kept working.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(LATIN_DIACRITICS, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .trim();
}

export function tokenise(text: string): string[] {
  const cleaned = normalise(text);
  return cleaned === '' ? [] : cleaned.split(' ');
}

/**
 * A query grows more variants that are known to mean the same thing.
 *
 * Rewriting is done on RUNS OF WORDS rather than one word at a time, and that
 * distinction is the whole reason this function exists. Substituting per word
 * cannot express `udaas -> low mood` or `bura lagta hai -> feeling low`: one
 * word would have to become two, or two words become one, and neither fits in a
 * single position. Both are exactly what a synonym table for Hindi and informal
 * English is full of.
 *
 * The original wording is always kept as the first variant. A concern phrased in
 * the patient's own words is the one most likely to be there, so a rewrite adds
 * a reading rather than replacing one.
 *
 * The table is read in both directions, so an admin adding `neend: [sleep]`
 * makes a concern phrased either way reachable from either query, and never has
 * to think about which side of the colon a word belongs on.
 */
export function queryVariants(query: string, synonyms: Record<string, string[]>): string[][] {
  const base = tokenise(query);
  if (base.length === 0) return [];

  const variants: string[][] = [base];
  const seen = new Set([base.join(' ')]);
  const pairs = bidirectionalPairs(synonyms);

  const consider = (tokens: string[] | null): void => {
    if (!tokens || variants.length >= MAX_VARIANTS) return;
    const key = tokens.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(tokens);
  };

  // *** EVERY READING COMES FROM THE ORIGINAL QUERY. *** Rewriting a rewrite
  // would let `a -> b -> c` walk a query into wording nobody wrote, one hop at a
  // time, and which hops happened would depend on the order the table was
  // written in. So each pair is applied to `base`, never to another variant.
  for (const [from, to] of pairs) consider(replaceRun(base, from, to));

  // Plus one reading with every applicable pair applied at once, so a sentence
  // that needs two words translated - "neend aur ghabrahat" - has a reading in
  // which both are. Substitution is simultaneous: output is never re-examined,
  // so this cannot chain either.
  consider(replaceAll(base, pairs));

  return variants;
}

/**
 * A query with more readings than this is one where the synonym table has
 * grown into a thesaurus. The cap keeps a pathological entry from turning one
 * search into thousands of comparisons.
 */
const MAX_VARIANTS = 24;

/** Every occurrence of `from` replaced by `to`, or null if it does not occur. */
function replaceRun(tokens: string[], from: string[], to: string[]): string[] | null {
  if (from.length === 0 || from.length > tokens.length) return null;

  const out: string[] = [];
  let index = 0;
  let replaced = false;
  while (index < tokens.length) {
    if (matchesAt(tokens, from, index)) {
      out.push(...to);
      index += from.length;
      replaced = true;
    } else {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return replaced ? out : null;
}

/**
 * Every pair applied in ONE left-to-right pass, longest key first so a
 * multi-word entry wins over a single word inside it. What a rewrite emits is
 * skipped over rather than re-read, which is what stops it feeding itself.
 * Returns null when nothing applied.
 */
function replaceAll(tokens: string[], pairs: [string[], string[]][]): string[] | null {
  const byLength = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const out: string[] = [];
  let index = 0;
  let replaced = false;

  while (index < tokens.length) {
    const hit = byLength.find(([from]) => matchesAt(tokens, from, index));
    if (hit) {
      out.push(...hit[1]);
      index += hit[0].length;
      replaced = true;
    } else {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return replaced ? out : null;
}

function matchesAt(tokens: string[], phrase: string[], start: number): boolean {
  if (start + phrase.length > tokens.length) return false;
  return phrase.every((word, offset) => tokens[start + offset] === word);
}

/** `{ neend: ['sleep'] }` yields `neend -> sleep` and `sleep -> neend`. */
function bidirectionalPairs(synonyms: Record<string, string[]>): [string[], string[]][] {
  const pairs: [string[], string[]][] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const left = tokenise(from);
    const right = tokenise(to);
    const key = `${left.join(' ')}=>${right.join(' ')}`;
    if (left.length === 0 || right.length === 0 || key.split('=>')[0] === key.split('=>')[1])
      return;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([left, right]);
  };

  for (const [word, meanings] of Object.entries(synonyms)) {
    for (const meaning of meanings) {
      add(word, meaning);
      add(meaning, word);
    }
  }
  return pairs;
}

/**
 * Whether a phrase appears in any reading of the query, as a run of consecutive
 * words.
 *
 * Consecutive, not scattered: "sleep" and "problem" at opposite ends of a long
 * sentence is not the phrase "sleep problem", and treating it as one is how a
 * search starts matching everything to everything.
 */
export function containsPhrase(variants: string[][], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false;
  return variants.some((variant) =>
    variant.some((_word, start) => matchesAt(variant, phraseTokens, start)),
  );
}

/**
 * How much a matched phrase is worth: the square of its length in words.
 *
 * Squared so that specificity beats accumulation. "sleep" matching three
 * concerns each on one common word must not outrank "cannot sleep at night"
 * matching one concern squarely, because the long phrase is the one the patient
 * actually said.
 */
export function phraseScore(phraseTokens: string[]): number {
  return phraseTokens.length * phraseTokens.length;
}

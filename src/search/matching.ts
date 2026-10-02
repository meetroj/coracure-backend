import { ConcernRecord } from '../catalogue/concerns.service';
import { containsPhrase, phraseScore, queryVariants, tokenise } from './query';

export interface ConcernMatch {
  concern: ConcernRecord;
  score: number;
  /** The phrases that actually matched, in the wording the taxonomy uses. */
  matchedPhrases: string[];
}

/**
 * Ranks the concern taxonomy against a query (FR-5.4).
 *
 * The whole engine is deterministic and reads only what an admin can edit: the
 * concern's own `match_phrases` (M-06) and the synonym table (M-09). That is the
 * point rather than a limitation - SRS section 8 requires the symptom mapping to
 * be clinically reviewed and approved, and copy nobody can predict the behaviour
 * of cannot meaningfully be approved.
 *
 * Scoring, in full:
 *   - a phrase scores the square of its length in words, so a specific phrase
 *     beats several vague ones;
 *   - the concern's own `match_weight` multiplies the total, which is the
 *     client's thumb on the scale for a concern they want reached readily;
 *   - the concern NAME is matched too, so a patient typing the taxonomy's own
 *     word finds it before anyone has written a single phrase.
 */
export function rankConcerns(
  query: string,
  concerns: ConcernRecord[],
  synonyms: Record<string, string[]>,
): ConcernMatch[] {
  const variants = queryVariants(query, synonyms);
  if (variants.length === 0) return [];

  const matches: ConcernMatch[] = [];
  for (const concern of concerns) {
    let score = 0;
    const matchedPhrases: string[] = [];

    for (const phrase of [concern.name, ...concern.matchPhrases]) {
      const tokens = tokenise(phrase);
      if (tokens.length === 0 || !containsPhrase(variants, tokens)) continue;
      score += phraseScore(tokens);
      // Shown to the patient as the reason, so it is the phrase as WRITTEN -
      // not the normalised form the matcher worked on.
      if (!matchedPhrases.includes(phrase)) matchedPhrases.push(phrase);
    }

    if (score > 0) {
      matches.push({ concern, score: score * Math.max(concern.matchWeight, 1), matchedPhrases });
    }
  }

  return matches.sort((a, b) => b.score - a.score || a.concern.name.localeCompare(b.concern.name));
}

/**
 * "matched to: sleep, anxiety" - FR-5.4's plain-language reason, in the
 * patient's own terms rather than a score they cannot interpret.
 *
 * At most three, because a reason listing eight phrases stops reading as an
 * explanation and starts reading as the system covering itself.
 */
export function reasonFor(matchedPhrases: string[]): string {
  return `matched to: ${matchedPhrases.slice(0, 3).join(', ')}`;
}

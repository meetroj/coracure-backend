import { containsPhrase, queryVariants, tokenise } from './query';

/**
 * *** THE CRISIS GUARDRAIL (FR-5.6, SRS 6.3). ***
 *
 * If a query contains self-harm or crisis language, the platform interrupts the
 * booking flow and shows emergency guidance INSTEAD of search results.
 *
 * Three properties this deliberately has, and each of them costs something:
 *
 *   1. **It runs first.** Before matching, before any ranking, before anything
 *      that could fail. A guardrail that runs after the work can be skipped by
 *      the work going wrong.
 *   2. **It is deterministic.** No model, no scoring, no threshold. The
 *      keyword list is clinically approved content (SRS section 8) and a list
 *      is the only form in which approval means anything - a clinician can read
 *      every phrase and say yes. It is also the only form that behaves the same
 *      way twice.
 *   3. **It never returns results alongside guidance.** Showing both would let
 *      a patient in crisis scroll past the help to the booking flow, which is
 *      exactly the interruption FR-5.6 asks for.
 *
 * The cost is recall: this finds what the list names and nothing else, so the
 * list has to be maintained. That is the right trade for a check whose failure
 * mode is missing somebody at their worst moment - a guess here is not better
 * than a gap, because a guess is a gap you cannot see.
 */
export function detectCrisis(
  query: string,
  keywords: string[],
  synonyms: Record<string, string[]> = {},
): boolean {
  const variants = queryVariants(query, synonyms);
  if (variants.length === 0) return false;

  return keywords.some((keyword) => {
    const tokens = tokenise(keyword);
    // Whole tokens in order, so `die` never fires on `diet` and `end it all`
    // needs those three words together. A substring check would make the
    // guardrail fire on innocent queries, and a guardrail that cries wolf is one
    // an operator eventually turns off.
    return tokens.length > 0 && containsPhrase(variants, tokens);
  });
}

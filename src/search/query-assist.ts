import { Injectable, Logger } from '@nestjs/common';

/**
 * The "AI-assisted" in FR-4.5's title, and the exact limit of what it may do.
 *
 * *** THE ASSISTANT NEVER DECIDES ANYTHING. *** It is asked one question - which
 * of these EXISTING concerns does this wording sound like - and its answer is a
 * list of codes that must already be in the taxonomy. It cannot invent a
 * concern, cannot rank above the approved mapping, cannot see a patient record,
 * and is never consulted about crisis language.
 *
 * That is not caution for its own sake. SRS 2.4 and section 8 both say the AI
 * module assists navigation only and must not screen, diagnose or triage
 * clinical severity; SRS section 8 also requires the symptom mapping to be
 * clinically approved. A model that could add its own categories would be
 * making a clinical judgement nobody reviewed.
 *
 * So it runs only where the deterministic mapping found NOTHING, which is the
 * one case where the alternative is an empty screen rather than a wrong answer.
 */
export const QUERY_ASSIST = Symbol('QueryAssist');

/** What the assistant is allowed to choose from. Names only - no patient data ever leaves. */
export interface AssistableConcern {
  code: string;
  name: string;
}

export interface QueryAssist {
  /**
   * Concern codes from `catalogue` that this wording might mean, best first.
   * NEVER throws: an assistant that is down is a search with fewer results, not
   * a failed request.
   */
  suggest(query: string, catalogue: AssistableConcern[]): Promise<string[]>;
}

/**
 * No assistant. The default, and a complete search on its own: the approved
 * mapping and the synonym table do all the work, and a query they cannot place
 * returns nothing rather than a guess.
 *
 * Unlike the OTP, storage and push stubs, this one is NOT refused in production.
 * Those three silently deliver nothing while looking healthy; this one only
 * declines to add suggestions to an answer the deterministic engine has already
 * given in full.
 */
@Injectable()
export class NoQueryAssist implements QueryAssist {
  suggest(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

/** Shared by the real adapter: keeps a slow model from holding a request open. */
export function withTimeout<T>(work: Promise<T>, ms: number, logger: Logger): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref()),
  ]).catch((error: unknown) => {
    logger.warn({ err: error }, 'Query assistant failed; falling back to the approved mapping');
    return null;
  });
}

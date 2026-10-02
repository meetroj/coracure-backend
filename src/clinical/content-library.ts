import { Injectable } from '@nestjs/common';

/**
 * The two questions the modules BEFORE M-18 ask about the content library:
 *
 *   1. is this a real, published item a doctor may recommend? (M-15, FR-15.4)
 *   2. what are these items called, so the Care Plan can show them? (M-16, FR-14.1)
 *
 * Both are answered by `content_items`, which M-18 owns and which did not exist
 * when M-15 and M-16 were written, so this is a port.
 *
 * *** NOTHING BINDS A DEFAULT HERE, AND THAT IS DELIBERATE. ***
 *
 * M-15 declares this token and leaves M-18 to supply it, exactly as M-05
 * declares `SPECIALTY_CATALOGUE` for M-06. Binding a fail-closed default in
 * M-15 looked safer and was worse: a module's own provider WINS over a global
 * one, so M-18 registering the real library changed nothing and every Care Hub
 * pick stayed unrecommendable. Without a binding, a missing M-18 fails loudly
 * at boot instead of quietly refusing every recommendation.
 */
export const CONTENT_LIBRARY = Symbol('ContentLibrary');

/** What a Care Plan needs to render a recommendation. Never the body. */
export interface ContentSummary {
  id: string;
  slug: string;
  itemType: string;
  title: string;
  summary: string | null;
}

export interface ContentLibrary {
  /**
   * Which of these ids are NOT published items a doctor may recommend.
   *
   * Returns the offenders rather than a boolean, so the doctor is told which
   * of their picks is the problem instead of being refused as a whole.
   */
  unrecommendable(ids: string[]): Promise<string[]>;

  /**
   * The items behind a recommendation, in the order asked for.
   *
   * Ids that no longer resolve - archived since the consultation, or deleted -
   * are simply absent. A Care Plan showing four of five recommendations is far
   * better than one that fails to load because one article was retired.
   */
  summaries(ids: string[]): Promise<ContentSummary[]>;
}

/**
 * The fail-closed shape, kept as documentation and for tests that want a
 * library which approves nothing. NOT bound by any module - see above.
 */
@Injectable()
export class NoContentLibrary implements ContentLibrary {
  /** Every id is unrecommendable, because no library is bound. */
  unrecommendable(ids: string[]): Promise<string[]> {
    return Promise.resolve([...ids]);
  }

  summaries(): Promise<ContentSummary[]> {
    return Promise.resolve([]);
  }
}

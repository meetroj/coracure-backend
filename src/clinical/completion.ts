/**
 * *** FR-11.5, AS A FUNCTION. ***
 *
 * "A consultation is marked clinically complete only after the prescription or
 * advice is finalised and the case summary is submitted. This rule is enforced
 * by the system, not by convention."
 *
 * Pure and separate from the service so the rule can be read in one place and
 * tested without a database. The database holds the same rule as a CHECK -
 * `clinical_records_finalised_is_complete` - because a service check is itself
 * a convention: it holds until somebody adds a second write path. This layer
 * exists on top of it to answer a question SQL cannot, which is WHICH closing
 * record this professional owes, and to say what is missing in words a doctor
 * can act on rather than as a constraint violation.
 */

/** One prescribed medicine. FR-9.5's structured form, as it is stored. */
export interface Medicine {
  /** A client-tracking uuid assigned on save - not a row key, this stays jsonb. */
  id: string;
  name: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions?: string | null;
  genericName?: string | null;
  route?: string | null;
  quantity?: string | null;
}

/** Only the parts of the record the completion rule reads. */
export interface Completable {
  caseSummary?: string | null;
  medicines: Medicine[];
  adviceCovered?: string | null;
  adviceHomePractice?: string | null;
  adviceNextFocus?: string | null;
  adviceWarningSigns?: string | null;
}

/**
 * FR-11.3: three to five lines.
 *
 * A floor and a ceiling, both meant. The floor is the point - a one-line
 * summary is not a handover, and the next clinician to open this case gets
 * nothing from it. The ceiling is what keeps it a SUMMARY rather than the notes
 * written twice.
 */
export const CASE_SUMMARY_MIN_LINES = 3;
export const CASE_SUMMARY_MAX_LINES = 5;

/** What a doctor still owes on this record. Empty means it can be finalised. */
export interface Outstanding {
  /** A stable code per requirement, so the app can drive its own worklist. */
  code:
    | 'CASE_SUMMARY_MISSING'
    | 'CASE_SUMMARY_TOO_SHORT'
    | 'CASE_SUMMARY_TOO_LONG'
    | 'PRESCRIPTION_OR_ADVICE_MISSING'
    | 'ADVICE_MISSING';
  message: string;
}

/** Non-blank lines. Blank lines between paragraphs are formatting, not content. */
export function caseSummaryLines(summary: string | null | undefined): string[] {
  return (summary ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Any part of the advice and therapy plan having been written. */
export function hasAdvicePlan(record: Completable): boolean {
  return (
    hasText(record.adviceCovered) ||
    hasText(record.adviceHomePractice) ||
    hasText(record.adviceNextFocus) ||
    hasText(record.adviceWarningSigns)
  );
}

/**
 * Everything still outstanding on this record, in the order a doctor would
 * work through it. Empty means finalising is allowed.
 *
 * `canPrescribe` is the professional's, not the patient's or the service's, and
 * it changes what the rule ASKS FOR rather than merely what it permits:
 *
 *   - a prescribing professional may close with a prescription OR with advice.
 *     Not every consultation ends in medicine, and refusing to close one that
 *     ends in "no medication indicated, here is the plan" would push doctors
 *     into prescribing something to get the case shut.
 *   - a non-prescribing professional must close with the advice and therapy
 *     plan, because it is the only closing record they can write. There is no
 *     branch here that lets an empty record through.
 *
 * The list is returned rather than thrown so FR-9.3's worklist and the finalise
 * call can share one implementation: the worklist shows what is outstanding,
 * and finalise refuses while anything is.
 */
export function outstandingFor(record: Completable, canPrescribe: boolean): Outstanding[] {
  const missing: Outstanding[] = [];

  const lines = caseSummaryLines(record.caseSummary);
  if (lines.length === 0) {
    missing.push({
      code: 'CASE_SUMMARY_MISSING',
      message: `A case summary of ${CASE_SUMMARY_MIN_LINES} to ${CASE_SUMMARY_MAX_LINES} lines is required.`,
    });
  } else if (lines.length < CASE_SUMMARY_MIN_LINES) {
    missing.push({
      code: 'CASE_SUMMARY_TOO_SHORT',
      message: `The case summary needs at least ${CASE_SUMMARY_MIN_LINES} lines; it has ${lines.length}.`,
    });
  } else if (lines.length > CASE_SUMMARY_MAX_LINES) {
    missing.push({
      code: 'CASE_SUMMARY_TOO_LONG',
      message: `The case summary is ${lines.length} lines; ${CASE_SUMMARY_MAX_LINES} is the most.`,
    });
  }

  const closed = canPrescribe
    ? record.medicines.length > 0 || hasAdvicePlan(record)
    : hasAdvicePlan(record);

  if (!closed) {
    missing.push(
      canPrescribe
        ? {
            code: 'PRESCRIPTION_OR_ADVICE_MISSING',
            message: 'Add a prescription, or an advice and therapy plan, before finalising.',
          }
        : {
            code: 'ADVICE_MISSING',
            message:
              'Add the advice and therapy plan before finalising. It is the closing record for your specialty.',
          },
    );
  }

  return missing;
}

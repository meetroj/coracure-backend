/** M-15's failure codes. Clients branch on these, never on the message. */
export const ClinicalError = {
  /**
   * *** FR-15.4. *** A Care Hub pick that is not a published item, so it cannot
   * be put in front of the patient. The `rejected` detail names which, so the
   * doctor can drop the offender rather than losing the whole selection.
   */
  CONTENT_NOT_RECOMMENDABLE: 'CONTENT_NOT_RECOMMENDABLE',
  /** No such consultation, or the caller is not a party to it. */
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  /** No clinical record has been started for that consultation yet. */
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  /**
   * *** THE RECORD IS FROZEN. *** It was finalised, and a finalised clinical
   * record is evidence: a prescription the patient is holding a PDF of, and the
   * handover the next clinician reads. A correction is a new consultation or an
   * addendum, never a quiet edit of what was already issued.
   */
  RECORD_FINALISED: 'RECORD_FINALISED',
  /**
   * *** FR-11.5. *** Finalising was asked for while something is still
   * outstanding. The `details` carry every missing requirement with its own
   * code, so the app can show a checklist rather than one message.
   */
  RECORD_INCOMPLETE: 'RECORD_INCOMPLETE',
  /**
   * *** FR-4.3. *** A medicine on a record whose professional's specialty does
   * not permit prescribing. A psychologist's closing record is the advice and
   * therapy plan; this is not a formatting rule but a scope-of-practice one.
   */
  PRESCRIBING_NOT_PERMITTED: 'PRESCRIBING_NOT_PERMITTED',
  /** Documentation asked for on a consultation that has not been held yet. */
  NOT_DOCUMENTABLE: 'NOT_DOCUMENTABLE',
} as const;

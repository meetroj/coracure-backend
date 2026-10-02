/** M-17's failure codes. Clients branch on these, never on the message. */
export const ClarificationError = {
  /** No such case, or not one this caller may see. FR-12.4's answer to both. */
  CASE_NOT_FOUND: 'CASE_NOT_FOUND',
  /**
   * *** FR-12.2. *** The free text carries something that could identify the
   * patient. Refused rather than redacted: silently rewriting a clinician's
   * words would leave them not knowing what the expert was actually shown.
   */
  IDENTIFIER_PRESENT: 'IDENTIFIER_PRESENT',
  /** Not at `expert` seniority. FR-12.4's first check: who MAY be asked. */
  NOT_AN_EXPERT: 'NOT_AN_EXPERT',
  /** The action does not belong to this status. */
  NOT_IN_THAT_STATE: 'NOT_IN_THAT_STATE',
  /** A case cannot be sent to its own author for a second opinion. */
  EXPERT_IS_THE_AUTHOR: 'EXPERT_IS_THE_AUTHOR',
  /** Editing a case an expert has already been shown. */
  ALREADY_POSTED: 'ALREADY_POSTED',
} as const;

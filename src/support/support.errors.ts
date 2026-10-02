/** M-19's failure codes. Clients branch on these, never on the message. */
export const SupportError = {
  /** No such complaint, or not one this caller may see. The same answer to both. */
  COMPLAINT_NOT_FOUND: 'COMPLAINT_NOT_FOUND',
  /**
   * Writing on a complaint that has been resolved or rejected. Not silencing:
   * a reply to a decision is an escalation, and an escalation that looks like a
   * reply on a closed ticket is one nobody is watching. A new complaint queues.
   */
  COMPLAINT_CLOSED: 'COMPLAINT_CLOSED',
  /** Both endings need one. A patient told only "rejected" has been dismissed. */
  RESOLUTION_NOTE_REQUIRED: 'RESOLUTION_NOTE_REQUIRED',
  /**
   * Rating a consultation that has not happened. FR-18.6 reads these as
   * evidence about a named clinician, so a cancellation is not a data point.
   */
  NOT_RATEABLE: 'NOT_RATEABLE',
  /** No such consultation, or not this patient's. */
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
} as const;

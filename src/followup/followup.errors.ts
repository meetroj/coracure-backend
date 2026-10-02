/** M-16's failure codes. Clients branch on these, never on the message. */
export const FollowupError = {
  /** No such consultation, or the caller is not a party to it. */
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  /** No pathway by that code, or no current version of it. */
  PATHWAY_NOT_FOUND: 'PATHWAY_NOT_FOUND',
  /** A question set or rule set that would not grade correctly. */
  PATHWAY_INVALID: 'PATHWAY_INVALID',
  /** A follow-up was asked for on a consultation with no clinical record. */
  NOT_YET_DOCUMENTED: 'NOT_YET_DOCUMENTED',
  /** No follow-up is running on this consultation. */
  FOLLOWUP_NOT_ACTIVE: 'FOLLOWUP_NOT_ACTIVE',
  /** A check-in for a date outside the follow-up window. */
  OUTSIDE_WINDOW: 'OUTSIDE_WINDOW',
  /**
   * Already answered today. One row per patient per day, and a second
   * submission would overwrite a safety answer that has already been acted on.
   */
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  /** A required question of the approved set was left unanswered. */
  CHECKIN_INCOMPLETE: 'CHECKIN_INCOMPLETE',
  /** No such alert, or not one this caller may see. */
  ALERT_NOT_FOUND: 'ALERT_NOT_FOUND',
  /** Closing an alert nobody has acknowledged. */
  ALERT_NOT_ACKNOWLEDGED: 'ALERT_NOT_ACKNOWLEDGED',
} as const;

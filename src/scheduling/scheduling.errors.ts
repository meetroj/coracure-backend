/** M-07's failure codes. Clients branch on these, never on the message. */
export const SchedulingError = {
  /** No availability rule with that id, or it belongs to another provider. */
  AVAILABILITY_RULE_NOT_FOUND: 'AVAILABILITY_RULE_NOT_FOUND',
  /** End at or before start, or a time outside the day. */
  INVALID_TIME_RANGE: 'INVALID_TIME_RANGE',
  /** Two windows on the same weekday, or the same date, cover the same minute. */
  OVERLAPPING_AVAILABILITY: 'OVERLAPPING_AVAILABILITY',
  /** Leave or an override asked for on a date that has already gone. */
  DATE_IN_THE_PAST: 'DATE_IN_THE_PAST',
  /**
   * *** THE CONFLICT GUARD *** The provider is not free for the whole of that
   * slot: outside their hours, blocked, or already booked. M-11 calls this
   * before it writes a consultation.
   */
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  /** More days asked for in one lookup than the module will compute. */
  RANGE_TOO_WIDE: 'RANGE_TOO_WIDE',
} as const;

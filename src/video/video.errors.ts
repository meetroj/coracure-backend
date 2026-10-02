/** M-14's failure codes. Clients branch on these, never on the message. */
export const VideoError = {
  /** No such consultation, or the caller is not one of its two parties. */
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  /**
   * *** FR-8.5. *** The caller is a party to the consultation, but the call is
   * not open to them yet or is over. The state is in the details so the app can
   * say which - "your doctor has not been assigned" reads very differently from
   * "this consultation has finished".
   */
  NOT_JOINABLE: 'NOT_JOINABLE',
  /** FR-8.5: no token before the money. The bill is M-12's to settle. */
  NOT_PAID: 'NOT_PAID',
  /** Too early. A scheduled consultation opens shortly before its start time. */
  TOO_EARLY: 'TOO_EARLY',
  /**
   * *** THE WEBHOOK SIGNATURE DID NOT VERIFY. *** Never a malformed request -
   * only LiveKit holds the key that signs these, so anything else is forged.
   * These webhooks are the only writer of `consultation_participants`, which
   * makes this check the only thing between an open endpoint and an invented
   * attendance record.
   */
  WEBHOOK_NOT_VERIFIED: 'WEBHOOK_NOT_VERIFIED',
  /** LiveKit is not configured. A deployment problem, not a caller's mistake. */
  VIDEO_UNAVAILABLE: 'VIDEO_UNAVAILABLE',
} as const;

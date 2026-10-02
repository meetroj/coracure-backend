/** M-21's failure codes. Clients branch on these, never on the message. */
export const ComplianceError = {
  /** Not an admin, or an admin whose level reads no part of the log. */
  NOT_PERMITTED: 'NOT_PERMITTED',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  /** Executing a request nobody approved. M-03 owns the approval. */
  NOT_APPROVED: 'NOT_APPROVED',
  /**
   * The erasure ran and failed. The reason is written onto the request row, not
   * into a separate column - a failure is an outcome, not a different kind of
   * thing.
   */
  DELETION_FAILED: 'DELETION_FAILED',
} as const;

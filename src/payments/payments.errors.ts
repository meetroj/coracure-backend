/** M-12's failure codes. Clients branch on these, never on the message. */
export const PaymentsError = {
  /** No payment row for that consultation, or the caller is not a party to it. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** Checkout asked for on a consultation that is not waiting for payment. */
  NOT_PAYABLE: 'NOT_PAYABLE',
  /** Already captured, or already paid out. Both are safe to retry into. */
  ALREADY_PAID: 'ALREADY_PAID',
  /** A refund on something never captured. */
  NOT_REFUNDABLE: 'NOT_REFUNDABLE',
  /** More than was charged. A CHECK enforces the same ceiling. */
  REFUND_EXCEEDS_CHARGE: 'REFUND_EXCEEDS_CHARGE',
  /**
   * *** FR-7.6 *** The webhook signature did not verify. Never a malformed
   * request - the only party who can produce a valid signature is the gateway,
   * so anything else is a forgery attempt and is logged as one.
   */
  WEBHOOK_NOT_VERIFIED: 'WEBHOOK_NOT_VERIFIED',
} as const;

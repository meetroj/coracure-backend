/**
 * The payment gateway.
 *
 * Razorpay is the only one this release integrates, which is why there is no
 * `gateway` column on the payment row - a constant is not data. It is still a
 * port, for the same reason the OTP and storage providers are: the flows above
 * it have to be drivable before an account exists.
 */
export const PAYMENT_GATEWAY = Symbol('PaymentGateway');

/** What the client needs to open the gateway's checkout. */
export interface GatewayOrder {
  orderId: string;
  /** In the smallest unit - paise - which is what every gateway expects. */
  amountPaise: number;
  currency: string;
  /** The public key the client SDK is initialised with. Never the secret. */
  publicKey: string;
}

export interface GatewayRefund {
  refundId: string;
  amountPaise: number;
}

/**
 * A webhook that has been checked and understood. Anything that fails the
 * signature check never becomes one of these.
 */
export type GatewayEvent =
  | {
      kind: 'payment_captured';
      orderId: string;
      paymentId: string;
      amountPaise: number;
      /** upi, card, netbanking, wallet (FR-7.1). */
      method: string | null;
    }
  | { kind: 'payment_failed'; orderId: string; paymentId: string | null; reason: string }
  | { kind: 'refund_processed'; paymentId: string; refundId: string; amountPaise: number }
  | { kind: 'ignored'; event: string };

export interface PaymentGateway {
  /** Creates the order the client checks out against. */
  createOrder(input: {
    amountPaise: number;
    /** Our own reference, so a gateway dashboard row can be traced back. */
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;

  /** Refunds part or all of a captured payment (FR-7.7). */
  refund(input: {
    gatewayPaymentId: string;
    amountPaise: number;
    notes?: Record<string, string>;
  }): Promise<GatewayRefund>;

  /**
   * *** THE ONLY WAY A PAYMENT BECOMES PAID (FR-7.6). ***
   *
   * Verifies the webhook's HMAC signature over the RAW body and returns what it
   * means. Returns null when the signature does not verify - and a null must be
   * treated as an attacker, not as a malformed request, because the whole point
   * of the signature is that only the gateway can produce one.
   *
   * The raw body matters: re-serialising parsed JSON changes key order and
   * whitespace, and the signature is over the bytes that were sent.
   */
  verifyWebhook(rawBody: string, signature: string): GatewayEvent | null;
}

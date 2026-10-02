import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

import { GatewayEvent, GatewayOrder, GatewayRefund, PaymentGateway } from './payment-gateway';
import { equalInConstantTime } from './razorpay.gateway';

/**
 * Local development without a Razorpay account. It settles NOTHING - no money
 * moves and no gateway is called.
 *
 * What it does do is sign its own webhooks under a fixed local secret, using
 * the same HMAC scheme the real one verifies. That matters: it means the
 * webhook path - signature check, idempotency, status transition - is exercised
 * in full rather than bypassed by a "trust me" switch. The one thing a stub
 * must never be is a second, looser route into the same state change.
 *
 * `env.validation` refuses this provider in production, so it cannot ship
 * pretending to have taken a payment.
 */
@Injectable()
export class StubPaymentGateway implements PaymentGateway {
  private readonly logger = new Logger(StubPaymentGateway.name);

  createOrder(input: { amountPaise: number; receipt: string }): Promise<GatewayOrder> {
    const orderId = `order_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.logger.warn(
      { orderId, amountPaise: input.amountPaise, receipt: input.receipt },
      'Stub payment gateway - no order was created and nothing will be charged',
    );
    return Promise.resolve({
      orderId,
      amountPaise: input.amountPaise,
      currency: 'INR',
      publicKey: 'rzp_stub_key',
    });
  }

  refund(input: { gatewayPaymentId: string; amountPaise: number }): Promise<GatewayRefund> {
    const refundId = `rfnd_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.logger.warn({ refundId, ...input }, 'Stub payment gateway - no money was returned');
    return Promise.resolve({ refundId, amountPaise: input.amountPaise });
  }

  /**
   * The same verification the real gateway does, against the stub secret. A
   * body signed with anything else is rejected exactly as a forged one would
   * be - so a local run cannot get into a state a production run could not.
   */
  verifyWebhook(rawBody: string, signature: string): GatewayEvent | null {
    const expected = signStubWebhook(rawBody);
    if (!equalInConstantTime(expected, signature)) {
      this.logger.warn('Rejected a stub webhook whose signature did not verify');
      return null;
    }

    try {
      const parsed = JSON.parse(rawBody) as GatewayEvent & { kind?: string };
      // The stub speaks the port's own vocabulary rather than Razorpay's, so a
      // local test writes what it means instead of a gateway's payload shape.
      if (
        parsed.kind === 'payment_captured' ||
        parsed.kind === 'payment_failed' ||
        parsed.kind === 'refund_processed'
      ) {
        return parsed;
      }
      return { kind: 'ignored', event: String(parsed.kind ?? 'unknown') };
    } catch {
      return null;
    }
  }
}

/** The fixed local secret. Never used by the Razorpay implementation. */
export const STUB_WEBHOOK_SECRET = 'coracure-stub-webhook-secret';

/** Exported so a local script or test can sign a body the stub will accept. */
export function signStubWebhook(rawBody: string): string {
  return createHmac('sha256', STUB_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

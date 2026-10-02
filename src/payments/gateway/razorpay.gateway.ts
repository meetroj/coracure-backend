import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env.validation';
import { GatewayEvent, GatewayOrder, GatewayRefund, PaymentGateway } from './payment-gateway';

/**
 * Razorpay (FR-7.1: UPI, cards, netbanking and wallets).
 *
 * The SDK is imported lazily so a deployment running on the stub never
 * constructs a client, and so a missing package cannot stop the service booting.
 */
@Injectable()
export class RazorpayGateway implements PaymentGateway {
  private readonly logger = new Logger(RazorpayGateway.name);
  private client?: RazorpayClient;

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    const razorpay = await this.sdk();
    const order = await razorpay.orders.create({
      amount: input.amountPaise,
      currency: CURRENCY,
      receipt: input.receipt,
      notes: input.notes,
    });
    return {
      orderId: order.id,
      amountPaise: input.amountPaise,
      currency: CURRENCY,
      // The PUBLIC key. The secret signs webhooks and never leaves the server.
      publicKey: env().RAZORPAY_KEY_ID!,
    };
  }

  async refund(input: {
    gatewayPaymentId: string;
    amountPaise: number;
    notes?: Record<string, string>;
  }): Promise<GatewayRefund> {
    const razorpay = await this.sdk();
    const refund = await razorpay.payments.refund(input.gatewayPaymentId, {
      amount: input.amountPaise,
      notes: input.notes,
    });
    return { refundId: refund.id, amountPaise: Number(refund.amount) };
  }

  /**
   * FR-7.6. The signature is an HMAC-SHA256 of the RAW body under the webhook
   * secret, compared in constant time - a byte-by-byte compare leaks where the
   * first difference is, which is enough to forge one given enough attempts.
   */
  verifyWebhook(rawBody: string, signature: string): GatewayEvent | null {
    const expected = createHmac('sha256', env().RAZORPAY_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('hex');
    if (!equalInConstantTime(expected, signature)) {
      this.logger.warn('Rejected a webhook whose signature did not verify');
      return null;
    }

    let parsed: RazorpayWebhook;
    try {
      parsed = JSON.parse(rawBody) as RazorpayWebhook;
    } catch {
      return null;
    }

    const payment = parsed.payload?.payment?.entity;
    const refund = parsed.payload?.refund?.entity;

    switch (parsed.event) {
      case 'payment.captured':
        if (!payment?.order_id || !payment.id) return { kind: 'ignored', event: parsed.event };
        return {
          kind: 'payment_captured',
          orderId: payment.order_id,
          paymentId: payment.id,
          amountPaise: Number(payment.amount ?? 0),
          method: payment.method ?? null,
        };
      case 'payment.failed':
        if (!payment?.order_id) return { kind: 'ignored', event: parsed.event };
        return {
          kind: 'payment_failed',
          orderId: payment.order_id,
          paymentId: payment.id ?? null,
          reason: payment.error_description ?? payment.error_reason ?? 'payment failed',
        };
      case 'refund.processed':
        if (!refund?.id || !refund.payment_id) return { kind: 'ignored', event: parsed.event };
        return {
          kind: 'refund_processed',
          paymentId: refund.payment_id,
          refundId: refund.id,
          amountPaise: Number(refund.amount ?? 0),
        };
      default:
        // Razorpay sends far more than the three events that matter here.
        // Anything else is acknowledged and ignored, so the gateway stops
        // retrying it rather than filling the log with failures.
        return { kind: 'ignored', event: parsed.event ?? 'unknown' };
    }
  }

  private async sdk(): Promise<RazorpayClient> {
    if (!this.client) {
      const Razorpay = (await import('razorpay')).default;
      this.client = new Razorpay({
        key_id: env().RAZORPAY_KEY_ID!,
        key_secret: env().RAZORPAY_KEY_SECRET!,
      });
    }
    return this.client;
  }
}

type RazorpayClient = InstanceType<typeof import('razorpay')>;

const CURRENCY = 'INR';

/** Length-safe, then constant-time. A mismatched length is simply not equal. */
export function equalInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        method?: string;
        error_description?: string;
        error_reason?: string;
      };
    };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
  };
}

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConsultationStatus, Payment, PaymentStatus, Prisma } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { Bill, Payout, billFromStored, calculateBill, payoutOf } from './billing';
import { GatewayEvent, PAYMENT_GATEWAY, PaymentGateway } from './gateway/payment-gateway';
import { PaymentsError } from './payments.errors';

export const CONVENIENCE_FEE_PCT_KEY = 'payments.convenience_fee_pct';
export const GST_PCT_KEY = 'payments.gst_pct';

/** FR-7.3's worked example uses both of these, so they are the defaults. */
export const DEFAULT_CONVENIENCE_FEE_PCT = 20;
export const DEFAULT_GST_PCT = 18;

const RATE = z.number().min(0).max(100);

/** What a patient sees. The bill in full (FR-7.2), plus where it has got to. */
export interface PaymentRecord {
  consultationId: string;
  status: PaymentStatus;
  bill: Bill;
  paymentMethod: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  refund: { amount: number; reason: string | null; refundedAt: Date | null } | null;
}

/** What the client needs to open checkout. */
export interface CheckoutSession {
  consultationId: string;
  bill: Bill;
  orderId: string;
  amountPaise: number;
  currency: string;
  publicKey: string;
}

/**
 * M-12 Payments and Billing. Owns `payments`, one row per consultation.
 *
 * *** THE BILL IS FROZEN AT CHECKOUT. *** The rates as well as the amounts, so
 * a bill can be reprinted months later showing the 20% it was actually charged
 * at rather than whatever the panel says today (FR-7.9). Changing a specialty
 * fee never rewrites an issued invoice.
 *
 * *** A PAYMENT BECOMES `paid` ONLY ON A VERIFIED WEBHOOK (FR-7.6). *** There
 * is no method on this service that marks one paid from a client result, and
 * that absence is the requirement. A client can be lied to; a signature cannot.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly booking: BookingService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  // -- Checkout -------------------------------------------------------------

  /**
   * Opens checkout for a consultation the patient is holding.
   *
   * The bill is computed and STORED here, before the gateway is called, so the
   * amount asked for and the amount recorded are the same figure. Calling the
   * gateway first and storing afterwards would leave a paid order with no bill
   * behind it if the write failed.
   */
  async startCheckout(consultationId: string, patientId: string): Promise<CheckoutSession> {
    const consultation = await this.prisma.consultation.findFirst({
      where: { id: consultationId, patientId },
      include: { specialty: true },
    });
    if (!consultation) throw notFound();
    if (consultation.status !== ConsultationStatus.pending_payment) {
      throw new AppException(
        PaymentsError.NOT_PAYABLE,
        'This consultation is not waiting for payment.',
        HttpStatus.CONFLICT,
      );
    }

    const existing = await this.prisma.payment.findUnique({ where: { consultationId } });
    if (existing?.status === PaymentStatus.paid) {
      throw new AppException(
        PaymentsError.ALREADY_PAID,
        'This consultation has already been paid for.',
        HttpStatus.CONFLICT,
      );
    }

    const bill = await this.quote(Number(consultation.specialty.consultationFeeInr));
    const amountPaise = Math.round(bill.totalPayable * 100);

    const order = await this.gateway.createOrder({
      amountPaise,
      receipt: consultation.referenceCode,
      notes: { consultationId, specialtyId: consultation.specialtyId },
    });

    // Upsert, because a patient who abandons checkout and comes back gets a
    // fresh order against the same bill rather than a second payment row - the
    // unique on `consultation_id` is what makes one bill per consultation true.
    await this.prisma.payment.upsert({
      where: { consultationId },
      create: {
        consultationId,
        consultationFee: bill.consultationFee,
        convenienceFeePct: bill.convenienceFeePct,
        convenienceFee: bill.convenienceFee,
        gstPct: bill.gstPct,
        gstAmount: bill.gstAmount,
        status: PaymentStatus.pending,
        gatewayOrderId: order.orderId,
      },
      update: { status: PaymentStatus.pending, gatewayOrderId: order.orderId },
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: 'payment',
      entityId: consultationId,
      consultationId,
      metadata: { orderId: order.orderId, amountPaise },
    });

    return {
      consultationId,
      bill,
      orderId: order.orderId,
      amountPaise,
      currency: order.currency,
      publicKey: order.publicKey,
    };
  }

  /** The rates in force, as the admin panel has them (FR-7.5). */
  async quote(consultationFee: number): Promise<Bill> {
    const [convenienceFeePct, gstPct] = await Promise.all([
      this.config.get(CONVENIENCE_FEE_PCT_KEY, RATE),
      this.config.get(GST_PCT_KEY, RATE),
    ]);
    return calculateBill({
      consultationFee,
      convenienceFeePct: convenienceFeePct ?? DEFAULT_CONVENIENCE_FEE_PCT,
      gstPct: gstPct ?? DEFAULT_GST_PCT,
    });
  }

  // -- The webhook ----------------------------------------------------------

  /**
   * *** THE ONLY WAY MONEY IS RECOGNISED (FR-7.6). ***
   *
   * The signature is checked against the RAW body first. Everything after that
   * point is idempotent, because a gateway retries until it is acknowledged and
   * the same capture arrives more than once as a matter of course.
   *
   * Returns quietly on anything it does not recognise: an unknown event is
   * acknowledged so the gateway stops retrying it, rather than failing and
   * being sent again for ever.
   */
  async handleWebhook(rawBody: string, signature: string): Promise<{ handled: boolean }> {
    const event = this.gateway.verifyWebhook(rawBody, signature);
    if (!event) {
      // Not a bad request - a forged one. The distinction matters in a log.
      throw new AppException(
        PaymentsError.WEBHOOK_NOT_VERIFIED,
        'Signature verification failed.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // The raw payload goes to the audit log rather than a gateway events table
    // (MODULES M-12). It is the evidence behind a disputed charge.
    await this.audit.record({
      actorType: 'system',
      action: 'webhook',
      entityType: 'payment_webhook',
      entityId: eventKey(event),
      metadata: { event: event.kind, payload: rawBody.slice(0, MAX_PAYLOAD_CHARS) },
    });

    switch (event.kind) {
      case 'payment_captured':
        return { handled: await this.capture(event) };
      case 'payment_failed':
        return { handled: await this.fail(event) };
      case 'refund_processed':
        return { handled: await this.settleRefund(event) };
      default:
        return { handled: false };
    }
  }

  private async capture(
    event: Extract<GatewayEvent, { kind: 'payment_captured' }>,
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: { gatewayOrderId: event.orderId },
    });
    if (!payment) {
      this.logger.warn({ orderId: event.orderId }, 'Capture for an order this platform never made');
      return false;
    }
    // *** IDEMPOTENCY *** the second delivery finds this set and stops here.
    if (payment.gatewayPaymentId) return false;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.paid,
        gatewayPaymentId: event.paymentId,
        paymentMethod: event.method,
        paidAt: new Date(),
        failureReason: null,
      },
    });

    // The booking becomes a booking. M-11 owns that transition and clears its
    // own hold, so the sweeper can never take a consultation that was paid for.
    await this.booking.confirmPayment(payment.consultationId);

    await this.audit.record({
      actorType: 'system',
      action: 'update',
      entityType: 'payment',
      entityId: payment.consultationId,
      consultationId: payment.consultationId,
      metadata: { to: 'paid', gatewayPaymentId: event.paymentId, method: event.method },
    });
    return true;
  }

  private async fail(event: Extract<GatewayEvent, { kind: 'payment_failed' }>): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: { gatewayOrderId: event.orderId },
    });
    // A failure after a capture is noise from a retried attempt, and must never
    // walk a paid consultation backwards.
    if (!payment || payment.status === PaymentStatus.paid) return false;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.failed, failureReason: event.reason.slice(0, 200) },
    });
    // The consultation is left holding its slot: FR-6.2 releases it on timeout,
    // and a patient whose card was declined may well retry within the window.
    return true;
  }

  private async settleRefund(
    event: Extract<GatewayEvent, { kind: 'refund_processed' }>,
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: { gatewayPaymentId: event.paymentId },
    });
    if (!payment) return false;
    // *** IDEMPOTENCY *** stops a replayed refund webhook double-refunding.
    if (payment.gatewayRefundId === event.refundId) return false;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.refunded,
        gatewayRefundId: event.refundId,
        refundedAt: new Date(),
      },
    });
    return true;
  }

  // -- Refunds (FR-7.7) -----------------------------------------------------

  /**
   * Raised from the admin panel only, and never for more than was charged - a
   * CHECK enforces the same ceiling, because a refund that exceeded the charge
   * would be the platform paying somebody to book.
   */
  async refund(
    consultationId: string,
    input: { amount?: number; reason: string },
    actor: AuthenticatedActor,
  ): Promise<PaymentRecord> {
    const payment = await this.require(consultationId);
    if (payment.status !== PaymentStatus.paid) {
      throw new AppException(
        PaymentsError.NOT_REFUNDABLE,
        'Only a payment that was captured can be refunded.',
        HttpStatus.CONFLICT,
      );
    }

    const bill = billFromStored(shapeAmounts(payment));
    const amount = input.amount ?? bill.totalPayable;
    if (amount <= 0 || amount > bill.totalPayable) {
      throw new AppException(
        PaymentsError.REFUND_EXCEEDS_CHARGE,
        `A refund must be between 0 and the ${bill.totalPayable} charged.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const refund = await this.gateway.refund({
      gatewayPaymentId: payment.gatewayPaymentId!,
      amountPaise: Math.round(amount * 100),
      notes: { consultationId },
    });

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundAmount: amount,
        refundReason: input.reason.slice(0, 200),
        refundInitiatedByAdminId: actor.id,
        gatewayRefundId: refund.refundId,
        refundedAt: new Date(),
        status: PaymentStatus.refunded,
      },
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'payment',
      entityId: consultationId,
      consultationId,
      metadata: {
        refundAmount: amount,
        reason: input.reason.slice(0, 200),
        gatewayRefundId: refund.refundId,
      },
    });
    return this.shape(updated);
  }

  // -- Reading --------------------------------------------------------------

  /** The patient's bill, and its refund status (FR-6.5, FR-7.7). */
  async billFor(consultationId: string, actor: AuthenticatedActor): Promise<PaymentRecord> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { patientId: true, doctorId: true },
    });
    if (!consultation) throw notFound();

    const isParty =
      (actor.type === 'patient' && actor.id === consultation.patientId) ||
      (actor.type === 'doctor' && actor.id === consultation.doctorId) ||
      actor.type === 'admin';
    if (!isParty) throw notFound();

    return this.shape(await this.require(consultationId));
  }

  /**
   * FR-7.4: what the provider is owed for one consultation.
   *
   * The figure is the PROVIDER's own fee, not what the patient was charged -
   * FR-7.9 allows the two to differ, and the payout view reports theirs.
   */
  async payoutFor(consultationId: string, doctorId: string): Promise<Payout> {
    const consultation = await this.prisma.consultation.findFirst({
      where: { id: consultationId, doctorId },
      include: { doctor: { select: { consultationFeeInr: true } }, payment: true },
    });
    if (!consultation?.payment) throw notFound();
    return payoutOf(
      Number(consultation.doctor?.consultationFeeInr ?? 0),
      consultation.payment.payoutPaidAt,
    );
  }

  /** The provider's earnings list (FR-9.9). */
  async payoutsForDoctor(
    doctorId: string,
    limit = 50,
  ): Promise<(Payout & { consultationId: string; referenceCode: string })[]> {
    const rows = await this.prisma.consultation.findMany({
      where: {
        doctorId,
        payment: { status: { in: [PaymentStatus.paid, PaymentStatus.refunded] } },
      },
      include: { doctor: { select: { consultationFeeInr: true } }, payment: true },
      orderBy: { scheduledStartAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return rows.map((row) => ({
      consultationId: row.id,
      referenceCode: row.referenceCode,
      ...payoutOf(Number(row.doctor?.consultationFeeInr ?? 0), row.payment?.payoutPaidAt ?? null),
    }));
  }

  /**
   * The unpaid-payout queue. Payouts are made BY HAND this release, so what the
   * platform owes is a report rather than a job.
   */
  async pendingPayouts(
    limit = 200,
  ): Promise<
    {
      consultationId: string;
      referenceCode: string;
      doctorId: string | null;
      doctorName: string | null;
      amount: number;
      paidAt: Date | null;
    }[]
  > {
    const rows = await this.prisma.consultation.findMany({
      where: { payment: { status: PaymentStatus.paid, payoutPaidAt: null } },
      include: {
        doctor: { select: { id: true, fullName: true, consultationFeeInr: true } },
        payment: true,
      },
      orderBy: { scheduledStartAt: 'asc' },
      take: Math.min(limit, 500),
    });
    return rows.map((row) => ({
      consultationId: row.id,
      referenceCode: row.referenceCode,
      doctorId: row.doctorId,
      doctorName: row.doctor?.fullName ?? null,
      amount: Number(row.doctor?.consultationFeeInr ?? 0),
      paidAt: row.payment?.paidAt ?? null,
    }));
  }

  /**
   * An admin records that the transfer was made.
   *
   * There is no `payout_reference` column: no screen prints a bank reference,
   * so the admin who marks it paid puts the reference in the metadata of this
   * audit entry, which is where a later question about it would be answered.
   */
  async markPayoutPaid(
    consultationId: string,
    reference: string | undefined,
    actor: AuthenticatedActor,
  ): Promise<Payout> {
    const payment = await this.require(consultationId);
    if (payment.status !== PaymentStatus.paid) {
      throw new AppException(
        PaymentsError.NOT_PAYABLE,
        'Nothing was captured for this consultation, so there is nothing to pay out.',
        HttpStatus.CONFLICT,
      );
    }
    if (payment.payoutPaidAt) {
      throw new AppException(
        PaymentsError.ALREADY_PAID,
        'This payout has already been marked paid.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { payoutPaidAt: new Date() },
    });
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'payout',
      entityId: consultationId,
      consultationId,
      metadata: { payoutReference: reference ?? null },
    });

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { doctor: { select: { consultationFeeInr: true } } },
    });
    return payoutOf(Number(consultation?.doctor?.consultationFeeInr ?? 0), new Date());
  }

  /** FR-18.4: transactions and refunds, as CSV. */
  async exportCsv(kind: 'transactions' | 'refunds'): Promise<string> {
    const rows = await this.prisma.payment.findMany({
      where: kind === 'refunds' ? { refundAmount: { gt: 0 } } : {},
      include: { consultation: { select: { referenceCode: true, doctorId: true } } },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_LIMIT,
    });

    const header =
      kind === 'refunds'
        ? 'reference,status,refund_amount,refund_reason,refunded_at'
        : 'reference,status,consultation_fee,convenience_fee,gst_amount,total_payable,method,paid_at';

    const lines = rows.map((row) => {
      const bill = billFromStored(shapeAmounts(row));
      return kind === 'refunds'
        ? csv([
            row.consultation.referenceCode,
            row.status,
            Number(row.refundAmount),
            row.refundReason ?? '',
            row.refundedAt?.toISOString() ?? '',
          ])
        : csv([
            row.consultation.referenceCode,
            row.status,
            bill.consultationFee,
            bill.convenienceFee,
            bill.gstAmount,
            bill.totalPayable,
            row.paymentMethod ?? '',
            row.paidAt?.toISOString() ?? '',
          ]);
    });
    return [header, ...lines].join('\n');
  }

  // -- Internals ------------------------------------------------------------

  private async require(consultationId: string): Promise<Payment> {
    const found = await this.prisma.payment.findUnique({ where: { consultationId } });
    if (!found) throw notFound();
    return found;
  }

  private shape(payment: Payment): PaymentRecord {
    const refundAmount = Number(payment.refundAmount);
    return {
      consultationId: payment.consultationId,
      status: payment.status,
      bill: billFromStored(shapeAmounts(payment)),
      paymentMethod: payment.paymentMethod,
      paidAt: payment.paidAt,
      failureReason: payment.failureReason,
      refund:
        refundAmount > 0
          ? { amount: refundAmount, reason: payment.refundReason, refundedAt: payment.refundedAt }
          : null,
    };
  }
}

/** `Decimal` off the row, as the numbers the bill helpers work in. */
function shapeAmounts(payment: {
  consultationFee: Prisma.Decimal;
  convenienceFeePct: Prisma.Decimal;
  convenienceFee: Prisma.Decimal;
  gstPct: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
}) {
  return {
    consultationFee: Number(payment.consultationFee),
    convenienceFeePct: Number(payment.convenienceFeePct),
    convenienceFee: Number(payment.convenienceFee),
    gstPct: Number(payment.gstPct),
    gstAmount: Number(payment.gstAmount),
  };
}

/** A stable id for the audit entry, so a replayed webhook is recognisable in the log. */
function eventKey(event: GatewayEvent): string {
  switch (event.kind) {
    case 'payment_captured':
      return event.paymentId;
    case 'payment_failed':
      return event.orderId;
    case 'refund_processed':
      return event.refundId;
    default:
      return event.event;
  }
}

/** Quotes every field: a refund reason is free text and will contain a comma. */
function csv(values: (string | number)[]): string {
  return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',');
}

const MAX_PAYLOAD_CHARS = 4000;
const EXPORT_LIMIT = 5000;

function notFound(): AppException {
  return new AppException(
    PaymentsError.PAYMENT_NOT_FOUND,
    'No payment exists for that consultation.',
    HttpStatus.NOT_FOUND,
  );
}

import { ConsultationStatus, PaymentStatus, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { AuthenticatedActor } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { GatewayEvent, PaymentGateway } from './gateway/payment-gateway';
import { PaymentsService } from './payments.service';

const ADMIN: AuthenticatedActor = { type: 'admin', id: 'admin-1', level: 'finance' };
const PATIENT: AuthenticatedActor = { type: 'patient', id: 'patient-1' };
const STRANGER: AuthenticatedActor = { type: 'patient', id: 'patient-9' };

type Row = Record<string, unknown>;
const dec = (value: number) => new Prisma.Decimal(value);

/** A row billed at FR-7.3's figures: 500 + 100 convenience + 108 GST = 708. */
const payment = (over: Row = {}) => ({
  id: 'payment-1',
  consultationId: 'consult-1',
  consultationFee: dec(500),
  convenienceFeePct: dec(20),
  convenienceFee: dec(100),
  gstPct: dec(18),
  gstAmount: dec(108),
  status: PaymentStatus.paid,
  gatewayOrderId: 'order_1',
  gatewayPaymentId: 'pay_1',
  paymentMethod: 'upi',
  paidAt: new Date('2026-09-14T09:00:00.000Z'),
  failureReason: null,
  refundAmount: dec(0),
  refundReason: null,
  refundInitiatedByAdminId: null,
  gatewayRefundId: null,
  refundedAt: null,
  payoutPaidAt: null,
  consultation: { referenceCode: 'CC-4K2M-7QX9', doctorId: 'doctor-1' },
  ...over,
});

function build(
  over: {
    found?: Row | null;
    consultation?: Row | null;
    event?: GatewayEvent | null;
    rates?: { convenience?: number; gst?: number };
  } = {},
) {
  const findUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(over.found === undefined ? payment() : over.found);
  const update = vi
    .fn<(args: { where: Row; data: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(payment(args.data)));
  const upsert = vi
    .fn<(args: { where: Row; create: Row; update: Row }) => Promise<Row>>()
    .mockImplementation((args) => Promise.resolve(payment(args.create)));
  const findMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([payment()]);

  const consultationFindFirst = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue(
      over.consultation === undefined
        ? {
            id: 'consult-1',
            patientId: 'patient-1',
            doctorId: 'doctor-1',
            referenceCode: 'CC-4K2M-7QX9',
            specialtyId: 'psychiatry',
            status: ConsultationStatus.pending_payment,
            specialty: { consultationFeeInr: dec(500) },
            doctor: { consultationFeeInr: dec(500) },
            payment: payment(),
          }
        : over.consultation,
    );
  const consultationFindUnique = vi
    .fn<(args: { where: Row }) => Promise<Row | null>>()
    .mockResolvedValue({
      patientId: 'patient-1',
      doctorId: 'doctor-1',
      doctor: { consultationFeeInr: dec(500) },
    });
  const consultationFindMany = vi.fn<() => Promise<Row[]>>().mockResolvedValue([]);

  const prisma = {
    payment: { findUnique, update, upsert, findMany },
    consultation: {
      findFirst: consultationFindFirst,
      findUnique: consultationFindUnique,
      findMany: consultationFindMany,
    },
  } as unknown as PrismaService;

  const record = vi.fn<(entry: Row) => Promise<void>>().mockResolvedValue(undefined);
  const get = vi
    .fn<(key: string) => Promise<number | undefined>>()
    .mockImplementation((key) =>
      Promise.resolve(
        key.includes('convenience') ? (over.rates?.convenience ?? 20) : (over.rates?.gst ?? 18),
      ),
    );
  const confirmPayment = vi.fn<() => Promise<unknown>>().mockResolvedValue({});

  const createOrder = vi
    .fn<
      (input: { amountPaise: number; receipt: string }) => Promise<{
        orderId: string;
        amountPaise: number;
        currency: string;
        publicKey: string;
      }>
    >()
    .mockResolvedValue({
      orderId: 'order_new',
      amountPaise: 70800,
      currency: 'INR',
      publicKey: 'k',
    });
  const refundFn = vi
    .fn<
      (input: { gatewayPaymentId: string; amountPaise: number }) => Promise<{
        refundId: string;
        amountPaise: number;
      }>
    >()
    .mockResolvedValue({ refundId: 'rfnd_1', amountPaise: 70800 });
  const verifyWebhook = vi
    .fn<() => GatewayEvent | null>()
    .mockReturnValue(over.event === undefined ? null : over.event);
  const gateway = { createOrder, refund: refundFn, verifyWebhook } as unknown as PaymentGateway;

  return {
    service: new PaymentsService(
      prisma,
      { record } as unknown as AuditService,
      { get } as unknown as AppConfigService,
      { confirmPayment } as unknown as BookingService,
      gateway,
    ),
    update,
    upsert,
    record,
    createOrder,
    refundFn,
    confirmPayment,
  };
}

describe('PaymentsService — checkout', () => {
  it('freezes the bill at FR-7.3’s figures before calling the gateway', async () => {
    // No payment row yet - this is the patient's first checkout.
    const { service, upsert, createOrder } = build({ found: null });
    const session = await service.startCheckout('consult-1', 'patient-1');

    expect(session.bill.totalPayable).toBe(708);
    expect(session.amountPaise).toBe(70800);
    // The rates are stored beside the amounts, so the bill can be reprinted
    // later showing the 20% it was actually charged at.
    expect(upsert.mock.calls[0][0].create).toMatchObject({
      consultationFee: 500,
      convenienceFeePct: 20,
      convenienceFee: 100,
      gstPct: 18,
      gstAmount: 108,
    });
    expect(createOrder.mock.calls[0][0]).toMatchObject({ amountPaise: 70800 });
  });

  it('refuses checkout on a consultation that is not awaiting payment', async () => {
    const { service } = build({
      consultation: {
        id: 'consult-1',
        patientId: 'patient-1',
        status: ConsultationStatus.scheduled,
        specialty: { consultationFeeInr: dec(500) },
      },
    });
    await expect(service.startCheckout('consult-1', 'patient-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'NOT_PAYABLE' },
    });
  });

  it('refuses a second checkout once the money is in', async () => {
    const { service } = build({ found: payment({ status: PaymentStatus.paid }) });
    await expect(service.startCheckout('consult-1', 'patient-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'ALREADY_PAID' },
    });
  });

  it('does not exist for a patient it is not for', async () => {
    const { service } = build({ consultation: null });
    await expect(service.startCheckout('consult-1', 'patient-9')).rejects.toMatchObject({
      status: 404,
      response: { code: 'PAYMENT_NOT_FOUND' },
    });
  });
});

describe('PaymentsService — the webhook (FR-7.6)', () => {
  const captured: GatewayEvent = {
    kind: 'payment_captured',
    orderId: 'order_1',
    paymentId: 'pay_new',
    amountPaise: 70800,
    method: 'upi',
  };

  it('*** rejects an unverified signature as a forgery, not a bad request ***', async () => {
    // The only party who can produce a valid signature is the gateway.
    const { service, update } = build({ event: null });
    await expect(service.handleWebhook('{}', 'nonsense')).rejects.toMatchObject({
      status: 401,
      response: { code: 'WEBHOOK_NOT_VERIFIED' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('marks the payment paid and tells booking the slot is settled', async () => {
    const { service, update, confirmPayment } = build({
      event: captured,
      found: payment({ status: PaymentStatus.pending, gatewayPaymentId: null, paidAt: null }),
    });
    await service.handleWebhook('{}', 'good');

    expect(update.mock.calls[0][0].data).toMatchObject({
      status: PaymentStatus.paid,
      gatewayPaymentId: 'pay_new',
      paymentMethod: 'upi',
    });
    // M-11 owns the transition and clears its own hold, so the sweeper can
    // never take a consultation that was paid for.
    expect(confirmPayment).toHaveBeenCalledWith('consult-1');
  });

  it('*** is idempotent ***, because a gateway delivers the same capture twice', async () => {
    const { service, update, confirmPayment } = build({
      event: captured,
      found: payment({ gatewayPaymentId: 'pay_already' }),
    });
    const result = await service.handleWebhook('{}', 'good');

    expect(result.handled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it('ignores a capture for an order this platform never made', async () => {
    const { service, update } = build({ event: captured, found: null });
    expect(await service.handleWebhook('{}', 'good')).toEqual({ handled: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('writes the raw payload to the audit log, not to a gateway events table', async () => {
    const { service, record } = build({
      event: captured,
      found: payment({ status: PaymentStatus.pending, gatewayPaymentId: null }),
    });
    await service.handleWebhook('{"event":"payment.captured"}', 'good');

    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'webhook',
      entityType: 'payment_webhook',
      metadata: { event: 'payment_captured', payload: '{"event":"payment.captured"}' },
    });
  });

  it('never walks a paid consultation backwards on a late failure', async () => {
    const { service, update } = build({
      event: { kind: 'payment_failed', orderId: 'order_1', paymentId: null, reason: 'declined' },
      found: payment({ status: PaymentStatus.paid }),
    });
    expect(await service.handleWebhook('{}', 'good')).toEqual({ handled: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('records a failure without releasing the slot', async () => {
    // FR-6.2 releases it on timeout; a declined card may well be retried.
    const { service, update } = build({
      event: { kind: 'payment_failed', orderId: 'order_1', paymentId: null, reason: 'declined' },
      found: payment({ status: PaymentStatus.pending, gatewayPaymentId: null, paidAt: null }),
    });
    await service.handleWebhook('{}', 'good');
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: PaymentStatus.failed,
      failureReason: 'declined',
    });
  });

  it('does not double-refund on a replayed refund webhook', async () => {
    const { service, update } = build({
      event: {
        kind: 'refund_processed',
        paymentId: 'pay_1',
        refundId: 'rfnd_1',
        amountPaise: 70800,
      },
      found: payment({ gatewayRefundId: 'rfnd_1' }),
    });
    expect(await service.handleWebhook('{}', 'good')).toEqual({ handled: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PaymentsService — refunds (FR-7.7)', () => {
  it('refunds the whole charge when no amount is given', async () => {
    const { service, refundFn, update } = build();
    await service.refund('consult-1', { reason: 'Provider could not attend' }, ADMIN);

    expect(refundFn.mock.calls[0][0]).toMatchObject({ amountPaise: 70800 });
    expect(update.mock.calls[0][0].data).toMatchObject({
      refundAmount: 708,
      refundInitiatedByAdminId: 'admin-1',
      status: PaymentStatus.refunded,
    });
  });

  it('*** refuses more than was charged ***', async () => {
    const { service, refundFn } = build();
    await expect(
      service.refund('consult-1', { amount: 1000, reason: 'too much' }, ADMIN),
    ).rejects.toMatchObject({ status: 400, response: { code: 'REFUND_EXCEEDS_CHARGE' } });
    expect(refundFn).not.toHaveBeenCalled();
  });

  it('refuses to refund something never captured', async () => {
    const { service } = build({ found: payment({ status: PaymentStatus.pending }) });
    await expect(service.refund('consult-1', { reason: 'nope' }, ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'NOT_REFUNDABLE' },
    });
  });

  it('records who authorised it and why', async () => {
    const { service, record } = build();
    await service.refund('consult-1', { amount: 300, reason: 'Partial, late cancellation' }, ADMIN);
    expect(record.mock.calls[0][0]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      metadata: { refundAmount: 300, reason: 'Partial, late cancellation' },
    });
  });
});

describe('PaymentsService — the bill and the payout', () => {
  it('shows a party the bill in full', async () => {
    const { service } = build();
    const record = await service.billFor('consult-1', PATIENT);
    expect(record.bill).toMatchObject({
      consultationFee: 500,
      convenienceFee: 100,
      subtotal: 600,
      gstAmount: 108,
      totalPayable: 708,
    });
  });

  it('does not exist for somebody who is not on the consultation', async () => {
    const { service } = build();
    await expect(service.billFor('consult-1', STRANGER)).rejects.toMatchObject({
      status: 404,
      response: { code: 'PAYMENT_NOT_FOUND' },
    });
  });

  it('reports FR-7.4’s payout: fee 500, deduction 0, earning 500', async () => {
    const { service } = build();
    expect(await service.payoutFor('consult-1', 'doctor-1')).toMatchObject({
      consultationFee: 500,
      platformDeduction: 0,
      doctorEarning: 500,
      status: 'pending',
    });
  });

  it('refuses to mark a payout paid when nothing was captured', async () => {
    const { service } = build({ found: payment({ status: PaymentStatus.pending }) });
    await expect(service.markPayoutPaid('consult-1', 'ref', ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'NOT_PAYABLE' },
    });
  });

  it('puts the bank reference in the audit entry, since no column holds it', async () => {
    const { service, record } = build();
    await service.markPayoutPaid('consult-1', 'NEFT/2026/09/0041', ADMIN);
    expect(record.mock.calls[0][0]).toMatchObject({
      entityType: 'payout',
      metadata: { payoutReference: 'NEFT/2026/09/0041' },
    });
  });

  it('will not pay the same payout twice', async () => {
    const { service } = build({ found: payment({ payoutPaidAt: new Date() }) });
    await expect(service.markPayoutPaid('consult-1', undefined, ADMIN)).rejects.toMatchObject({
      status: 409,
      response: { code: 'ALREADY_PAID' },
    });
  });
});

describe('PaymentsService — CSV export (FR-18.4)', () => {
  it('quotes every field, because a refund reason contains commas', async () => {
    const { service } = build();
    const csv = await service.exportCsv('transactions');
    const [header, row] = csv.split('\n');

    expect(header).toContain('total_payable');
    expect(row).toContain('"708"');
    expect(row.startsWith('"CC-4K2M-7QX9"')).toBe(true);
  });
});
